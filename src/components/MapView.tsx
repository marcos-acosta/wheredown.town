"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import boundariesData from "../data/boundaries";
import { manhattanData, manhattanCenter } from "../data/manhattan";
import { RegionShare } from "../lib/types";
import styles from "./MapView.module.css";

const BEARING = 29;
const INITIAL_CENTER: [number, number] = [-73.9927, 40.7356];
const INITIAL_ZOOM = 13.5;
const RESULTS_CENTER: [number, number] = [-73.9753, 40.734];
const RESULTS_ZOOM = 12;
// Voting mode: zoom scales with viewport width (Manhattan width fills screen)
const ZOOM_BREAKPOINT_WIDTH = 1000;
// Results mode: zoom scales with viewport height (Manhattan height fills left panel)
const RESULTS_ZOOM_BREAKPOINT_HEIGHT = 900;
const ZOOM_SCALE = 1;

// --- Results page layout ---
// Column fractions for the three sections: map | graph | text.
// Text fraction is 0 on narrow screens (no text column).
const LAYOUT_BREAKPOINT = 1000; // px — threshold for wide (three-column) layout
const NARROW_LAYOUT = { map: 0.55, graph: 0.45, text: 0 };
const WIDE_LAYOUT = { map: 0.4, graph: 0.25, text: 0.35 };

function getResultsLayout(screenWidth: number) {
  const col = screenWidth >= LAYOUT_BREAKPOINT ? WIDE_LAYOUT : NARROW_LAYOUT;
  return {
    mapWidth: Math.round(screenWidth * col.map),
    graphWidth: Math.round(screenWidth * col.graph),
    textWidth: Math.round(screenWidth * col.text),
  };
}

// --- Chart rendering ---
// Fraction of graph panel width used by the bar chart line (leaves right margin).
const GRAPH_BAR_FRACTION = 0.9;
// Maximum bar length in px (the "height" of a bar in horizontal-bar-chart terms).
const MAX_BAR_WIDTH = 300;
// Minimum bar width in px so zero-vote items don't cause the curve to touch x=0.
const GRAPH_MIN_BAR_PX = 2;

function getAdaptiveZoom(
  viewportSize: number,
  breakpoint: number,
  referenceZoom: number,
): number {
  return Math.min(
    referenceZoom,
    referenceZoom + ZOOM_SCALE * Math.log2(viewportSize / breakpoint),
  );
}

const GLOW_COLOR = "#00ff88";
const SNAP_DEBOUNCE_MS = 180;
const SCROLL_SCALE = 0.2;
const RESULTS_SCROLL_SCALE = 0.4;

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

// Sorted by index (south → north), matching the regionShares array ordering
const SORTED_BOUNDARIES = [...BOUNDARIES].sort((a, b) => a.index - b.index);

const MANHATTAN_COORDS = (
  manhattanData.features[0].geometry as GeoJSON.LineString
).coordinates as [number, number][];

// Closed polygon for use with Mapbox 'within' filter expressions
const MANHATTAN_POLYGON: GeoJSON.Feature<GeoJSON.Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      MANHATTAN_COORDS[0].toString() ===
      MANHATTAN_COORDS[MANHATTAN_COORDS.length - 1].toString()
        ? MANHATTAN_COORDS
        : [...MANHATTAN_COORDS, MANHATTAN_COORDS[0]],
    ],
  },
};

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

// Precompute east coast intersection points for each boundary (geographic coords)
const eastCoastPoints: ([number, number] | null)[] = SORTED_BOUNDARIES.map(
  (b) => {
    const east = findCoastIntersection(
      b.coordinates[0],
      b.coordinates[b.coordinates.length - 1],
      COAST_TIP_INDEX,
      MANHATTAN_COORDS.length - 1,
    );
    return east ? east.point : null;
  },
);

// Returns { shown, dirWord } using strictly-above and strictly-below counts,
// so voters who chose the boundary exactly don't inflate either side.
function getShownPct(
  shares: RegionShare[],
  idx: number,
): { shown: number; dirWord: "above" | "below" } {
  const total = shares[0]?.number ?? 1;
  const strictlyBelow = (total - (shares[idx]?.number ?? 0)) / total;
  const strictlyAbove = (shares[idx + 1]?.number ?? 0) / total;
  if (strictlyBelow >= strictlyAbove) {
    return { shown: strictlyBelow, dirWord: "below" };
  }
  return { shown: strictlyAbove, dirWord: "above" };
}

function getLabel(percentile: number): string {
  if (percentile < 0.1) return "downtown gatekeeper";
  if (percentile <= 0.25) return "downtown elitist";
  if (percentile <= 0.35) return "downtown purist";
  if (percentile <= 0.65) return "downtown neutral";
  if (percentile <= 0.75) return "downtown generalist";
  if (percentile <= 0.9) return "downtown populist";
  return "downtown anarchist";
}

interface MapViewProps {
  onVote: (boundaryIndex: number) => Promise<void>;
  voted: boolean;
  regionShares: RegionShare[];
  userBoundaryIndex: number | null;
}

export default function MapView({
  onVote,
  voted,
  regionShares,
  userBoundaryIndex,
}: MapViewProps) {
  const [voting, setVoting] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && !!navigator.share;

  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const downtownLabelRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const resultsHeaderRef = useRef<HTMLDivElement | null>(null);
  const alignmentPrefixRef = useRef<HTMLDivElement | null>(null);
  const restingActionsRef = useRef<HTMLSpanElement | null>(null);
  const showAlignmentRef = useRef<HTMLButtonElement | null>(null);
  const headerLabelRef = useRef<HTMLDivElement | null>(null);
  const headerTextPercentRef = useRef<HTMLSpanElement | null>(null);
  const headerTextRef = useRef<HTMLSpanElement | null>(null);
  const headerTextHighlightRef = useRef<HTMLSpanElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingDeltaRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const activeBoundaryRef = useRef<Boundary>(BOUNDARIES[0]);
  const votedRef = useRef(voted);
  const regionSharesRef = useRef(regionShares);
  const userBoundaryIndexRef = useRef(userBoundaryIndex);
  const enterResultsModeRef = useRef<(() => void) | null>(null);
  const showRestingHeaderRef = useRef<(() => void) | null>(null);
  const updateAllRef = useRef<((b: Boundary) => void) | null>(null);
  const updateGraphRef = useRef<(() => void) | null>(null);
  const graphYsRef = useRef<number[]>([]);
  const graphRevealedRef = useRef(false);
  const isDraggingResultsRef = useRef(false);

  useEffect(() => {
    votedRef.current = voted;
  }, [voted]);

  useEffect(() => {
    regionSharesRef.current = regionShares;
    if (voted && graphRevealedRef.current && updateGraphRef.current) {
      updateGraphRef.current();
    }
    if (voted && activeBoundaryRef.current) {
      updateHeaderTextExternal(activeBoundaryRef.current);
      updateUserLabel();
    }
  }, [regionShares, voted]);

  useEffect(() => {
    userBoundaryIndexRef.current = userBoundaryIndex;
  }, [userBoundaryIndex]);

  // Enter results mode when voted flips to true (map already loaded)
  useEffect(() => {
    if (!voted) return;
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded() && enterResultsModeRef.current) {
      enterResultsModeRef.current();
    }
  }, [voted]);

  function buildShareText(): string {
    const shares = regionSharesRef.current;
    if (!shares.length) return "https://wheredown.town";
    const userIdx = userBoundaryIndexRef.current ?? 0;
    const userBoundary = SORTED_BOUNDARIES[userIdx] ?? SORTED_BOUNDARIES[0];
    const total = shares[0]?.number ?? 1;
    const strictlyAbove = (shares[userIdx + 1]?.number ?? 0) / total;
    const label = getLabel((total - (shares[userIdx]?.number ?? 0)) / total);
    const labelWithArticle = label.includes("neutral") ? label : `a ${label}`;
    const pctToShow = Math.round(strictlyAbove * 100);
    return `My downtown elitism index is ${pctToShow}! I think Downtown Manhattan starts at ${userBoundary.name}, which makes me ${labelWithArticle}. https://wheredown.town`;
  }

  async function handleShare() {
    const text = buildShareText();
    if (navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function updateUserLabel() {
    if (isDraggingResultsRef.current) return;
    if (!headerLabelRef.current) return;
    const shares = regionSharesRef.current;
    if (!shares.length) return;
    const userIdx = userBoundaryIndexRef.current ?? 0;
    const total = shares[0]?.number ?? 1;
    const atOrAbove = shares[userIdx]?.number ?? 0;
    const pct = (total - atOrAbove) / total;
    headerLabelRef.current.textContent = getLabel(pct);
  }

  function updateHeaderTextExternal(boundary: Boundary) {
    if (isDraggingResultsRef.current) return;
    if (
      !headerTextPercentRef.current ||
      !headerTextRef.current ||
      !headerTextHighlightRef.current
    )
      return;
    const shares = regionSharesRef.current;
    if (!shares.length) return;
    const total = shares[0]?.number ?? 1;
    const above = (shares[boundary.index + 1]?.number ?? 0) / total;
    headerTextPercentRef.current.textContent = `${Math.round(above * 100)}%`;
    headerTextRef.current.textContent = ` of people placed the boundary `;
    headerTextHighlightRef.current.textContent = `above ${boundary.name}`;
  }

  // Main map setup — runs once
  useEffect(() => {
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: "mapbox://styles/mapbox/dark-v11",
      center: INITIAL_CENTER,
      zoom: getAdaptiveZoom(
        window.innerWidth,
        ZOOM_BREAKPOINT_WIDTH,
        INITIAL_ZOOM,
      ),
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

    function getEastScreenPos(
      sortedIdx: number,
    ): { x: number; y: number } | null {
      const coord = eastCoastPoints[sortedIdx];
      if (!coord) return null;
      const pt = map.project(coord);
      return { x: pt.x, y: pt.y };
    }

    function getEastScreenY(sortedIdx: number): number | null {
      return getEastScreenPos(sortedIdx)?.y ?? null;
    }

    function updateAll(boundary: Boundary) {
      activeBoundaryRef.current = boundary;
      updateGlowLine(boundary);
      updateFill(boundary);
      if (!votedRef.current) {
        updateLabel(boundary);
        updateDowntownLabel(boundary);
      }
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

    function getVotePct(sortedIdx: number): number {
      const shares = regionSharesRef.current;
      if (shares.length === 0) return 0;
      const cur = shares[sortedIdx]?.number ?? 0;
      const next = shares[sortedIdx + 1]?.number ?? 0;
      const total = shares[0]?.number ?? 1;
      return (cur - next) / total;
    }

    function getPercentile(boundaryIdx: number): number {
      const shares = regionSharesRef.current;
      if (!shares.length) return 0;
      const total = shares[0]?.number ?? 1;
      const atOrAbove = shares[boundaryIdx]?.number ?? 0;
      return (total - atOrAbove) / total;
    }

    function updateHeaderText(boundary: Boundary) {
      if (
        !headerTextPercentRef.current ||
        !headerTextRef.current ||
        !headerTextHighlightRef.current
      )
        return;
      const shares = regionSharesRef.current;
      if (!shares.length) return;
      const total = shares[0]?.number ?? 1;
      const above = (shares[boundary.index + 1]?.number ?? 0) / total;
      headerTextPercentRef.current.textContent = `${Math.round(above * 100)}%`;
      headerTextRef.current.textContent = ` of people placed the boundary `;
      headerTextHighlightRef.current.textContent = `above ${boundary.name}`;
    }

    function updateGraph() {
      const svg = svgRef.current;
      if (!svg) return;
      const W = svg.clientWidth;
      const n = SORTED_BOUNDARIES.length;
      const activeIdx = activeBoundaryRef.current.index;

      // Anchor equidistant Y range to the actual east coast screen Ys of the
      // southernmost and northernmost boundaries.
      const bottomY = getEastScreenY(0) ?? window.innerHeight * 0.85;
      const topY = getEastScreenY(n - 1) ?? window.innerHeight * 0.15;

      // Equidistant graph Y positions: i=0 (south) → bottomY, i=n-1 (north) → topY
      const graphYs = SORTED_BOUNDARIES.map(
        (_, i) => bottomY + (topY - bottomY) * (i / (n - 1)),
      );
      graphYsRef.current = graphYs;

      const xs = SORTED_BOUNDARIES.map((_, i) => getVotePct(i));
      const maxX = Math.max(...xs, 0.001);
      const points = SORTED_BOUNDARIES.map((_, i) => ({
        x: Math.max(
          GRAPH_MIN_BAR_PX,
          Math.min((xs[i] / maxX) * W * GRAPH_BAR_FRACTION, MAX_BAR_WIDTH),
        ),
        y: graphYs[i],
      }));

      const markerY = graphYs[activeIdx];
      const eastPos = getEastScreenPos(activeIdx);
      // Convert east coast screen X to SVG-local coordinates (may be negative)
      const svgLeft = svg.getBoundingClientRect().left;
      const eastX = (eastPos?.x ?? svgLeft) - svgLeft;
      const eastY = eastPos?.y ?? markerY;

      const polyPts = points.map((p) => `${p.x},${p.y}`).join(" ");

      const abovePts = points.filter((p) => p.y <= markerY);
      let shadedPts = "";
      if (abovePts.length > 0) {
        const topPtY = Math.min(...abovePts.map((p) => p.y));
        shadedPts =
          `0,${markerY} ` +
          abovePts.map((p) => `${p.x},${p.y}`).join(" ") +
          ` 0,${topPtY}`;
      }

      svg.innerHTML = `
        ${shadedPts ? `<polygon points="${shadedPts}" fill="${GLOW_COLOR}" fill-opacity="0.8" />` : ""}
        <polyline
          points="${polyPts}"
          fill="none"
          stroke="${GLOW_COLOR}"
          stroke-width="2"
          stroke-opacity="0.8"
        />
        <polyline
          points="${eastX},${eastY} 0,${markerY} ${W},${markerY}"
          fill="none"
          stroke="${GLOW_COLOR}"
          stroke-width="1.5"
          stroke-opacity="0.6"
          stroke-dasharray="4 4"
        />
      `;
    }

    function findClosestByY(screenY: number): Boundary {
      const graphYs = graphYsRef.current;
      let closest = SORTED_BOUNDARIES[0];
      let minDist = Infinity;
      SORTED_BOUNDARIES.forEach((b, i) => {
        const y = graphYs[i] ?? getEastScreenY(i);
        if (y === null || y === undefined) return;
        const d = Math.abs(y - screenY);
        if (d < minDist) {
          minDist = d;
          closest = b;
        }
      });
      return closest;
    }

    function applyLayout() {
      const { graphWidth, textWidth } = getResultsLayout(window.innerWidth);
      if (svgRef.current) {
        svgRef.current.style.width = graphWidth + "px";
        svgRef.current.style.right = textWidth + "px";
      }
      if (resultsHeaderRef.current) {
        const isWide = textWidth > 0;
        if (isWide) {
          Object.assign(resultsHeaderRef.current.style, {
            right: "0px",
            left: "auto",
            top: "50%",
            transform: "translateY(-50%)",
            width: textWidth + "px",
          });
        } else {
          Object.assign(resultsHeaderRef.current.style, {
            right: "auto",
            left: "50%",
            top: "24px",
            transform: "translateX(-50%)",
            width: "100vw",
          });
        }
      }
      if (resultsHeaderRef.current)
        resultsHeaderRef.current.style.visibility = "visible";
      return { graphWidth, textWidth };
    }

    function enterResultsMode() {
      // Hide voting UI elements
      if (labelRef.current) labelRef.current.style.display = "none";
      if (downtownLabelRef.current)
        downtownLabelRef.current.style.display = "none";

      // Restrict road labels to Manhattan only
      map.getStyle().layers.forEach((layer) => {
        if (layer.type === "symbol" && layer.id.startsWith("road")) {
          const existing = map.getFilter(layer.id);
          const withinFilter: mapboxgl.Expression = [
            "within",
            MANHATTAN_POLYGON,
          ];
          map.setFilter(
            layer.id,
            existing ? ["all", existing, withinFilter] : withinFilter,
          );
        }
      });

      const { graphWidth, textWidth } = applyLayout();

      map.easeTo({
        center: RESULTS_CENTER,
        zoom: getAdaptiveZoom(
          window.innerHeight,
          RESULTS_ZOOM_BREAKPOINT_HEIGHT,
          RESULTS_ZOOM,
        ),
        bearing: BEARING,
        padding: { right: graphWidth + textWidth, left: 0, top: 0, bottom: 0 },
        duration: 1000,
      });

      // Default to user's boundary
      const defaultIdx = userBoundaryIndexRef.current ?? 0;
      const defaultBoundary =
        SORTED_BOUNDARIES[defaultIdx] ?? SORTED_BOUNDARIES[0];
      updateAll(defaultBoundary);

      updateHeaderText(defaultBoundary);

      setTimeout(() => {
        graphRevealedRef.current = true;
        updateGraph();
      }, 1000);

      // --- Header display modes ---

      function showDraggingHeader(boundary: Boundary) {
        isDraggingResultsRef.current = true;
        if (alignmentPrefixRef.current)
          alignmentPrefixRef.current.style.display = "none";
        if (restingActionsRef.current)
          restingActionsRef.current.style.display = "none";
        if (showAlignmentRef.current)
          showAlignmentRef.current.style.display = "inline";
        if (headerLabelRef.current)
          headerLabelRef.current.classList.add(styles.resultsLabelDragging);
        const shares = regionSharesRef.current;
        const total = shares[0]?.number ?? 1;
        const above = (shares[boundary.index + 1]?.number ?? 0) / total;
        if (headerLabelRef.current)
          headerLabelRef.current.textContent = `${Math.round(above * 100)}%`;
        if (headerTextPercentRef.current)
          headerTextPercentRef.current.textContent = "";
        if (headerTextRef.current)
          headerTextRef.current.textContent = "of people placed the boundary ";
        if (headerTextHighlightRef.current)
          headerTextHighlightRef.current.textContent = `above ${boundary.name}`;
      }

      function showRestingHeader() {
        isDraggingResultsRef.current = false;
        if (alignmentPrefixRef.current)
          alignmentPrefixRef.current.style.display = "";
        if (restingActionsRef.current)
          restingActionsRef.current.style.display = "";
        if (showAlignmentRef.current)
          showAlignmentRef.current.style.display = "none";
        if (headerLabelRef.current)
          headerLabelRef.current.classList.remove(styles.resultsLabelDragging);
        const userBoundary =
          SORTED_BOUNDARIES[userBoundaryIndexRef.current ?? 0] ??
          SORTED_BOUNDARIES[0];
        updateAll(userBoundary);
        updateGraph();
        updateUserLabel();
        updateHeaderText(userBoundary);
      }

      showRestingHeaderRef.current = showRestingHeader;

      // Drag interaction
      const container = containerRef.current!;
      let isDragging = false;

      function onDragMove(screenY: number) {
        const boundary = findClosestByY(screenY);
        if (boundary === activeBoundaryRef.current) return;
        updateAll(boundary);
        updateGraph();
        showDraggingHeader(boundary);
      }

      function onMouseDown() {
        isDragging = true;
        showDraggingHeader(activeBoundaryRef.current);
      }
      function onMouseUp() {
        isDragging = false;
      }
      function onMouseMove(e: MouseEvent) {
        if (isDragging) onDragMove(e.clientY);
      }
      let wheelPending = 0;
      let wheelRaf: number | null = null;
      function onWheelResults(e: WheelEvent) {
        wheelPending += e.deltaY;
        if (wheelRaf !== null) return;
        wheelRaf = requestAnimationFrame(() => {
          const step = wheelPending > 0 ? 1 : -1;
          wheelPending = 0;
          wheelRaf = null;
          const currentIdx = activeBoundaryRef.current.index;
          const nextIdx = Math.max(
            0,
            Math.min(SORTED_BOUNDARIES.length - 1, currentIdx + step),
          );
          const boundary = SORTED_BOUNDARIES[nextIdx];
          if (boundary === activeBoundaryRef.current) return;
          updateAll(boundary);
          updateGraph();
          showDraggingHeader(boundary);
        });
      }
      function onTouchStartResults(e: TouchEvent) {
        showDraggingHeader(activeBoundaryRef.current);
        onDragMove(e.touches[0].clientY);
      }
      function onTouchMoveResults(e: TouchEvent) {
        e.preventDefault();
        onDragMove(e.touches[0].clientY);
      }

      container.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mouseup", onMouseUp);
      window.addEventListener("mousemove", onMouseMove);
      container.addEventListener("wheel", onWheelResults, { passive: true });
      container.addEventListener("touchstart", onTouchStartResults, {
        passive: true,
      });
      container.addEventListener("touchmove", onTouchMoveResults, {
        passive: false,
      });
    }

    enterResultsModeRef.current = enterResultsMode;
    updateAllRef.current = updateAll;
    updateGraphRef.current = updateGraph;

    // --- Map load ---

    map.on("load", () => {
      const HIDDEN_LABEL_LAYERS = new Set([
        "settlement-subdivision-label",
        "settlement-major-label",
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
      if (votedRef.current) {
        const { graphWidth, textWidth } = applyLayout();
        map.jumpTo({
          zoom: getAdaptiveZoom(
            window.innerHeight,
            RESULTS_ZOOM_BREAKPOINT_HEIGHT,
            RESULTS_ZOOM,
          ),
          padding: {
            right: graphWidth + textWidth,
            left: 0,
            top: 0,
            bottom: 0,
          },
        });
        updateGraph();
        updateAll(activeBoundaryRef.current);
      } else {
        map.jumpTo({
          zoom: getAdaptiveZoom(
            window.innerWidth,
            ZOOM_BREAKPOINT_WIDTH,
            INITIAL_ZOOM,
          ),
        });
        if (updateAllRef.current) {
          updateAllRef.current(activeBoundaryRef.current);
        }
      }
    }
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
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
      <svg ref={svgRef} className={styles.lineGraph} />
      <div ref={labelRef} className={styles.label} />
      <div ref={downtownLabelRef} className={styles.downtownLabel}>
        DOWNTOWN
      </div>
      {!voted && (
        <button
          className={`${styles.voteButton}${voting ? ` ${styles.voteButtonVoting}` : ""}`}
          onClick={() => {
            if (voting) return;
            setVoting(true);
            const timer = setTimeout(() => setShowLoading(true), 1000);
            onVote(activeBoundaryRef.current.index).finally(() =>
              clearTimeout(timer),
            );
          }}
        >
          {showLoading ? "Loading..." : "This is downtown"}
        </button>
      )}
      {voted && (
        <div ref={resultsHeaderRef} className={styles.resultsHeader}>
          <div ref={alignmentPrefixRef}>Your alignment is</div>
          <div ref={headerLabelRef} className={styles.resultsLabel} />
          <div className={styles.resultsText}>
            <span
              ref={headerTextPercentRef}
              className={styles.resultsTextHighlight}
            />
            <span ref={headerTextRef} />
            <br />
            <span
              ref={headerTextHighlightRef}
              className={`${styles.resultsTextHighlight} ${styles.noWrap}`}
            />
          </div>
          <div className={styles.resultsActions}>
            <span ref={restingActionsRef} className={styles.actionRow}>
              <span className={styles.dragHint}>Scroll to explore</span>
              <span> &mdash; </span>
              <button className={styles.shareButton} onClick={handleShare}>
                {canShare ? "Share" : copied ? "Copied!" : "Copy"}
              </button>
              <span> &mdash; </span>
              <span>
                <a href="https://marcos.ac" target="_blank">
                  About
                </a>
              </span>
            </span>
            <button
              ref={showAlignmentRef}
              className={`${styles.shareButton} ${styles.hidden}`}
              onClick={() => showRestingHeaderRef.current?.()}
            >
              Show my alignment
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
