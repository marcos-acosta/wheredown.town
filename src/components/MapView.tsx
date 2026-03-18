"use client";

import { useEffect, useRef } from "react";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import boundariesData from "../data/boundaries";
import { manhattanData, manhattanCenter } from "../data/manhattan";
import regionsData from "../data/regions";
import { RegionShare } from "../lib/types";
import styles from "./MapView.module.css";

const BEARING = 29;
const INITIAL_CENTER: [number, number] = [-73.9927, 40.7356];
const INITIAL_ZOOM = 13.5;
const RESULTS_CENTER: [number, number] = [-73.9903, 40.7345];
const RESULTS_ZOOM = 12.5;
// Viewport width (px) at which the reference zooms exactly fit Manhattan's width.
// Below this, zoom scales down proportionally so the full width stays visible.
const ZOOM_BREAKPOINT_WIDTH = 1000;
// How aggressively zoom responds to width changes below the breakpoint.
// 1 = mathematically exact (halving width removes 1 zoom level).
// < 1 = gentler falloff (allows slight overflow on small screens).
const ZOOM_SCALE = 1;

function getAdaptiveZoom(viewportWidth: number, referenceZoom: number): number {
  return Math.min(
    referenceZoom,
    referenceZoom +
      ZOOM_SCALE * Math.log2(viewportWidth / ZOOM_BREAKPOINT_WIDTH),
  );
}

const GLOW_COLOR = "#00ff88";
const SNAP_DEBOUNCE_MS = 180;
const SCROLL_SCALE = 0.2;
const MAX_REGION_OPACITY = 0.55;

interface Boundary {
  index: number;
  name: string;
  coordinates: [number, number][];
  interpolatedLat: (lng: number) => number;
  downtownFontScale?: number;
  downtownRotation?: number;
}

function parseBoundaries(): Boundary[] {
  const fc = boundariesData as GeoJSON.FeatureCollection;
  return fc.features.map((feature) => {
    const coords = (feature.geometry as GeoJSON.LineString).coordinates as [
      number,
      number,
    ][];
    const props = feature.properties as {
      index: number;
      mainStreet: string;
      downtownFontScale?: number;
      downtownRotation?: number;
    };
    const {
      index,
      mainStreet: name,
      downtownFontScale,
      downtownRotation,
    } = props;

    function interpolatedLat(targetLng: number): number {
      if (targetLng <= coords[0][0]) return coords[0][1];
      if (targetLng >= coords[coords.length - 1][0])
        return coords[coords.length - 1][1];
      for (let i = 0; i < coords.length - 1; i++) {
        const [lng0, lat0] = coords[i];
        const [lng1, lat1] = coords[i + 1];
        const minLng = Math.min(lng0, lng1);
        const maxLng = Math.max(lng0, lng1);
        if (targetLng >= minLng && targetLng <= maxLng) {
          const t = (targetLng - lng0) / (lng1 - lng0);
          return lat0 + t * (lat1 - lat0);
        }
      }
      return coords[coords.length - 1][1];
    }

    return {
      index,
      name,
      coordinates: coords,
      interpolatedLat,
      downtownFontScale,
      downtownRotation,
    };
  });
}

const BOUNDARIES = parseBoundaries();

// Sorted south → north by lat at the initial center longitude
const SORTED_BOUNDARIES = [...BOUNDARIES].sort(
  (a, b) =>
    a.interpolatedLat(INITIAL_CENTER[0]) - b.interpolatedLat(INITIAL_CENTER[0]),
);

const MANHATTAN_COORDS = (
  manhattanData.features[0].geometry as GeoJSON.LineString
).coordinates as [number, number][];

const CENTER_COORDS = (
  manhattanCenter.features[0].geometry as GeoJSON.LineString
).coordinates as [number, number][];

function centerLngAtLat(targetLat: number): number {
  if (targetLat <= CENTER_COORDS[0][1]) return CENTER_COORDS[0][0];
  if (targetLat >= CENTER_COORDS[CENTER_COORDS.length - 1][1])
    return CENTER_COORDS[CENTER_COORDS.length - 1][0];
  for (let i = 0; i < CENTER_COORDS.length - 1; i++) {
    const [lng0, lat0] = CENTER_COORDS[i];
    const [lng1, lat1] = CENTER_COORDS[i + 1];
    if (targetLat >= lat0 && targetLat <= lat1) {
      const t = (targetLat - lat0) / (lat1 - lat0);
      return lng0 + t * (lng1 - lng0);
    }
  }
  return CENTER_COORDS[CENTER_COORDS.length - 1][0];
}

const COAST_TIP_INDEX = MANHATTAN_COORDS.reduce(
  (best, c, i) => (c[1] < MANHATTAN_COORDS[best][1] ? i : best),
  0,
);

function lineSegmentIntersect(
  lp1: [number, number],
  lp2: [number, number],
  sp1: [number, number],
  sp2: [number, number],
): [number, number] | null {
  const dx1 = lp2[0] - lp1[0],
    dy1 = lp2[1] - lp1[1];
  const dx2 = sp2[0] - sp1[0],
    dy2 = sp2[1] - sp1[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null;
  const u = ((sp1[0] - lp1[0]) * dy1 - (sp1[1] - lp1[1]) * dx1) / denom;
  if (u < 0 || u > 1) return null;
  const t = ((sp1[0] - lp1[0]) * dy2 - (sp1[1] - lp1[1]) * dx2) / denom;
  return [lp1[0] + t * dx1, lp1[1] + t * dy1];
}

function findCoastIntersection(
  lp1: [number, number],
  lp2: [number, number],
  from: number,
  to: number,
): { point: [number, number]; seg: number } | null {
  for (let i = from; i < to; i++) {
    const pt = lineSegmentIntersect(
      lp1,
      lp2,
      MANHATTAN_COORDS[i],
      MANHATTAN_COORDS[i + 1],
    );
    if (pt) return { point: pt, seg: i };
  }
  return null;
}

function buildSouthernFill(
  boundary: Boundary,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const bCoords = boundary.coordinates;
  const bFirst = bCoords[0];
  const bLast = bCoords[bCoords.length - 1];

  const westIsect = findCoastIntersection(bFirst, bLast, 0, COAST_TIP_INDEX);
  const eastIsect = findCoastIntersection(
    bFirst,
    bLast,
    COAST_TIP_INDEX,
    MANHATTAN_COORDS.length - 1,
  );

  if (!westIsect || !eastIsect) {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[...bCoords, bCoords[0]]] },
    };
  }

  const coastSlice = MANHATTAN_COORDS.slice(
    westIsect.seg + 1,
    eastIsect.seg + 1,
  ).reverse();

  const ring: [number, number][] = [
    ...bCoords,
    eastIsect.point,
    ...coastSlice,
    westIsect.point,
    bCoords[0],
  ];

  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

function panAlongBearing(map: mapboxgl.Map, pixels: number) {
  const center = map.getCenter();
  const mpp =
    (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) /
    (256 * Math.pow(2, map.getZoom()));
  const meters = pixels * mpp;
  const rad = (BEARING * Math.PI) / 180;
  const dlat = (meters * Math.cos(rad)) / 111111;
  const dlng =
    (meters * Math.sin(rad)) /
    (111111 * Math.cos((center.lat * Math.PI) / 180));

  const minLat = SORTED_BOUNDARIES[0].interpolatedLat(center.lng);
  const maxLat = SORTED_BOUNDARIES[
    SORTED_BOUNDARIES.length - 1
  ].interpolatedLat(center.lng);
  const clampedLat = Math.max(minLat, Math.min(maxLat, center.lat + dlat));
  if (clampedLat === center.lat + dlat) {
    map.jumpTo({ center: [center.lng + dlng, clampedLat] });
  } else {
    map.jumpTo({ center: [center.lng, clampedLat] });
  }
}

function ptToSegDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax,
    dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function findClosestBoundary(map: mapboxgl.Map): Boundary {
  const canvas = map.getCanvas();
  const cx = canvas.width / devicePixelRatio / 2;
  const cy = canvas.height / devicePixelRatio / 2;

  let closest = BOUNDARIES[0];
  let minDist = Infinity;
  for (const b of BOUNDARIES) {
    for (let i = 0; i < b.coordinates.length - 1; i++) {
      const a = map.project(b.coordinates[i] as [number, number]);
      const p = map.project(b.coordinates[i + 1] as [number, number]);
      const d = ptToSegDist(cx, cy, a.x, a.y, p.x, p.y);
      if (d < minDist) {
        minDist = d;
        closest = b;
      }
    }
  }
  return closest;
}

interface MapViewProps {
  onVote: (boundaryIndex: number) => void;
  voted: boolean;
  regionShares: RegionShare[];
}

export default function MapView({ onVote, voted, regionShares }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const downtownLabelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingDeltaRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const activeBoundaryRef = useRef<Boundary>(BOUNDARIES[0]);
  const votedRef = useRef(voted);
  const regionSharesRef = useRef(regionShares);
  // Stored inside main useEffect so it captures `map`; called by voted useEffect
  const enterResultsModeRef = useRef<(() => void) | null>(null);
  const updateAllRef = useRef<((b: Boundary) => void) | null>(null);
  const hoverCleanupRef = useRef<(() => void) | null>(null);

  // Keep refs in sync with props
  useEffect(() => {
    votedRef.current = voted;
  }, [voted]);

  useEffect(() => {
    regionSharesRef.current = regionShares;
  }, [regionShares]);

  // Update Mapbox feature states when regionShares changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !voted || regionShares.length === 0 || !map.isStyleLoaded())
      return;
    regionShares.forEach((region, i) => {
      map.setFeatureState(
        { source: "regions", id: i },
        { share: region.percent },
      );
    });
  }, [regionShares, voted]);

  // Enter results mode when voted flips to true (map already loaded)
  useEffect(() => {
    if (!voted) return;
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded() && enterResultsModeRef.current) {
      enterResultsModeRef.current();
    }
    // If not yet loaded, map.on('load') will call it via votedRef check
  }, [voted]);

  // Main map setup — runs once
  useEffect(() => {
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: "mapbox://styles/mapbox/dark-v11",
      center: INITIAL_CENTER,
      zoom: getAdaptiveZoom(window.innerWidth, INITIAL_ZOOM),
      bearing: BEARING,
      interactive: false,
    });
    mapRef.current = map;

    function getBoundaryScreenMidpoint(boundary: Boundary): {
      x: number;
      y: number;
    } {
      const pts = boundary.coordinates.map((c) =>
        map.project(c as [number, number]),
      );
      let totalLen = 0;
      for (let i = 0; i < pts.length - 1; i++)
        totalLen += Math.hypot(
          pts[i + 1].x - pts[i].x,
          pts[i + 1].y - pts[i].y,
        );
      const half = totalLen / 2;
      let accumulated = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const segLen = Math.hypot(
          pts[i + 1].x - pts[i].x,
          pts[i + 1].y - pts[i].y,
        );
        if (accumulated + segLen >= half) {
          const t = (half - accumulated) / segLen;
          return {
            x: pts[i].x + t * (pts[i + 1].x - pts[i].x),
            y: pts[i].y + t * (pts[i + 1].y - pts[i].y),
          };
        }
        accumulated += segLen;
      }
      return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
    }

    function updateAll(boundary: Boundary) {
      activeBoundaryRef.current = boundary;
      updateGlowLine(boundary);
      updateFill(boundary);
      updateLabel(boundary);
      updateDowntownLabel(boundary);
    }

    function updateLabel(boundary: Boundary) {
      if (!labelRef.current) return;
      labelRef.current.textContent = boundary.name;
      const { x } = getBoundaryScreenMidpoint(boundary);
      labelRef.current.style.left = x + "px";
      labelRef.current.style.top = "";
    }

    function updateGlowLine(boundary: Boundary) {
      const source = map.getSource("active-boundary") as
        | GeoJSONSource
        | undefined;
      if (!source) return;
      source.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: boundary.coordinates },
      });
    }

    function updateDowntownLabel(boundary: Boundary) {
      if (!downtownLabelRef.current) return;
      const tipLat = MANHATTAN_COORDS[COAST_TIP_INDEX][1];
      const refLng = centerLngAtLat(tipLat);
      const midLat = (tipLat + boundary.interpolatedLat(refLng)) / 2;
      const midLng = centerLngAtLat(midLat);
      const pt = map.project([midLng, midLat]);
      downtownLabelRef.current.style.left = pt.x + "px";
      downtownLabelRef.current.style.top = pt.y + "px";
      downtownLabelRef.current.style.setProperty(
        "--boundary-scale",
        String(boundary.downtownFontScale ?? 1),
      );
      downtownLabelRef.current.style.setProperty(
        "--rotation",
        `${boundary.downtownRotation ?? 0}deg`,
      );
    }

    function updateFill(boundary: Boundary) {
      const source = map.getSource("southern-fill") as
        | GeoJSONSource
        | undefined;
      if (!source) return;
      source.setData(buildSouthernFill(boundary));
    }

    function snapToBoundary(boundary: Boundary) {
      const canvas = map.getCanvas();
      const w = canvas.width / devicePixelRatio;
      const h = canvas.height / devicePixelRatio;
      const center = map.unproject([w / 2, h / 2]);
      const targetLat = boundary.interpolatedLat(center.lng);
      map.easeTo({ center: [center.lng, targetLat], duration: 350 });
    }

    function handleScrollEnd() {
      const boundary = findClosestBoundary(map);
      snapToBoundary(boundary);
    }

    function applyDelta(delta: number) {
      if (votedRef.current) return;
      map.stop();

      pendingDeltaRef.current += delta;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        panAlongBearing(map, pendingDeltaRef.current * SCROLL_SCALE);
        const closest = findClosestBoundary(map);
        updateAll(closest);
        pendingDeltaRef.current = 0;
        rafRef.current = null;
      });

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(handleScrollEnd, SNAP_DEBOUNCE_MS);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 20;
      if (e.deltaMode === 2) delta *= 400;
      applyDelta(delta);
    }

    function onTouchStart(e: TouchEvent) {
      touchStartYRef.current = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      if (touchStartYRef.current === null) return;
      const dy = touchStartYRef.current - e.touches[0].clientY;
      touchStartYRef.current = e.touches[0].clientY;
      applyDelta(dy);
    }

    // --- Results mode ---

    function enterResultsMode() {
      // Hide voting UI
      if (downtownLabelRef.current)
        downtownLabelRef.current.style.display = "none";
      if (labelRef.current) labelRef.current.innerHTML = "";

      // Clear voting layers
      (map.getSource("active-boundary") as GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: [],
      });
      (map.getSource("southern-fill") as GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: [],
      });

      // Zoom out to show all boundaries
      map.easeTo({
        center: RESULTS_CENTER,
        zoom: getAdaptiveZoom(window.innerWidth, RESULTS_ZOOM),
        bearing: BEARING,
        duration: 1000,
      });

      // Apply any regionShares that arrived before results mode was entered
      regionSharesRef.current.forEach((region, i) => {
        map.setFeatureState(
          { source: "regions", id: i },
          { share: region.percent },
        );
      });

      // Hover: use queryRenderedFeatures (works without interactive: true)
      const container = containerRef.current!;
      let lastHoveredIndex: number | null = null;

      function onMouseMove(e: MouseEvent) {
        const rect = container.getBoundingClientRect();
        const pt = [e.clientX - rect.left, e.clientY - rect.top] as [
          number,
          number,
        ];
        const features = map.queryRenderedFeatures(pt, {
          layers: ["regions-fill"],
        });

        if (!features.length) {
          if (lastHoveredIndex !== null) clearHover();
          return;
        }

        const idx = features[0].properties!.index as number;
        if (idx === lastHoveredIndex) return;
        lastHoveredIndex = idx;

        // Dim all regions above hovered
        const n = (regionsData as GeoJSON.FeatureCollection).features.length;
        for (let i = 0; i < n; i++) {
          map.setFeatureState(
            { source: "regions", id: i },
            { dimmed: i > idx },
          );
        }

        // Position label above the boundary that forms the top of the hovered region
        if (labelRef.current) {
          const boundary = SORTED_BOUNDARIES[idx];
          const { x, y } = getBoundaryScreenMidpoint(boundary);
          const pct = regionSharesRef.current[idx]?.percent ?? 0;
          if (pct === 0) {
            labelRef.current.innerHTML = "";
          } else {
            labelRef.current.innerHTML = `${Math.round(pct * 100)}%<br><span class="${styles.labelSub}">consider ${boundary.name} downtown</span>`;
            labelRef.current.style.left = x + "px";
            labelRef.current.style.top = y - 110 + "px";
          }
        }
      }

      function clearHover() {
        lastHoveredIndex = null;
        if (labelRef.current) labelRef.current.innerHTML = "";
        const n = (regionsData as GeoJSON.FeatureCollection).features.length;
        for (let i = 0; i < n; i++) {
          map.setFeatureState({ source: "regions", id: i }, { dimmed: false });
        }
      }

      container.addEventListener("mousemove", onMouseMove);
      container.addEventListener("mouseleave", clearHover);
      hoverCleanupRef.current = () => {
        container.removeEventListener("mousemove", onMouseMove);
        container.removeEventListener("mouseleave", clearHover);
      };
    }

    enterResultsModeRef.current = enterResultsMode;
    updateAllRef.current = updateAll;

    // --- Map load ---

    map.on("load", () => {
      // Hide place/geo labels but keep road/street labels visible.
      // IDs may vary by style version — check map.getStyle().layers in console if something looks off.
      const HIDDEN_LABEL_LAYERS = new Set([
        "settlement-subdivision-label", // neighborhood names ("Tribeca", "Midtown")
        "settlement-major-label", // city names ("Manhattan", "New York")
        "settlement-minor-label",
        "state-label",
        "country-label",
        "natural-point-label",
        "natural-line-label",
        "water-point-label",
        "waterway-label",
        "airport-label",
        "poi-label",
      ]);
      map.getStyle().layers.forEach((layer) => {
        if (layer.type === "symbol" && HIDDEN_LABEL_LAYERS.has(layer.id)) {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      });

      // Voting layers
      map.addSource("southern-fill", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "southern-fill-layer",
        type: "fill",
        source: "southern-fill",
        paint: { "fill-color": GLOW_COLOR, "fill-opacity": 0.08 },
      });

      map.addSource("active-boundary", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "boundary-glow",
        type: "line",
        source: "active-boundary",
        paint: {
          "line-color": GLOW_COLOR,
          "line-width": 16,
          "line-opacity": 0.25,
          "line-blur": 8,
        },
      });
      map.addLayer({
        id: "boundary-core",
        type: "line",
        source: "active-boundary",
        paint: {
          "line-color": GLOW_COLOR,
          "line-width": 2.5,
          "line-opacity": 1,
        },
      });

      // Results layer — always added; opacity driven by feature-state
      map.addSource("regions", {
        type: "geojson",
        data: regionsData as GeoJSON.FeatureCollection,
      });
      map.addLayer({
        id: "regions-fill",
        type: "fill",
        source: "regions",
        paint: {
          "fill-color": GLOW_COLOR,
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "dimmed"], false],
            0,
            [
              "*",
              MAX_REGION_OPACITY,
              ["number", ["feature-state", "share"], 0],
            ],
          ],
        },
      });

      if (votedRef.current) {
        enterResultsMode();
      } else {
        const initial =
          BOUNDARIES.find((b) => b.name === "14th St") ?? BOUNDARIES[0];
        updateAll(initial);
        snapToBoundary(initial);
      }

      const container = containerRef.current!;
      container.addEventListener("wheel", onWheel, { passive: false });
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
    });

    function onResize() {
      map.resize();
      const refZoom = votedRef.current ? RESULTS_ZOOM : INITIAL_ZOOM;
      map.jumpTo({ zoom: getAdaptiveZoom(window.innerWidth, refZoom) });
      if (!votedRef.current && updateAllRef.current) {
        updateAllRef.current(activeBoundaryRef.current);
      }
    }
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (hoverCleanupRef.current) hoverCleanupRef.current();
      const container = containerRef.current;
      if (container) {
        container.removeEventListener("wheel", onWheel);
        container.removeEventListener("touchstart", onTouchStart);
        container.removeEventListener("touchmove", onTouchMove);
      }
      map.remove();
    };
  }, []);

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.map} />
      <div ref={labelRef} className={styles.label} />
      <div ref={downtownLabelRef} className={styles.downtownLabel}>
        DOWNTOWN
      </div>
      {!voted && (
        <button
          className={styles.voteButton}
          onClick={() => onVote(activeBoundaryRef.current.index)}
        >
          This is downtown
        </button>
      )}
    </div>
  );
}
