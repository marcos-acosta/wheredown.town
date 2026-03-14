"use client";

import { useEffect, useRef } from "react";
import mapboxgl, { GeoJSONSource } from "mapbox-gl";
import boundariesData from "../data/boundaries";
import styles from "./MapView.module.css";

const BEARING = 29;
const INITIAL_CENTER: [number, number] = [-73.998, 40.7265];
const INITIAL_ZOOM = 13.5;
const GLOW_COLOR = "#00ff88";
const SNAP_DEBOUNCE_MS = 180;
const SCROLL_SCALE = 0.2;

interface Boundary {
  name: string;
  coordinates: [number, number][];
  interpolatedLat: (lng: number) => number;
}

function parseBoundaries(): Boundary[] {
  const fc = boundariesData as GeoJSON.FeatureCollection;
  return fc.features.map((feature) => {
    const coords = (feature.geometry as GeoJSON.LineString).coordinates as [
      number,
      number,
    ][];
    const name = (feature.properties as { mainStreet: string }).mainStreet;

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

    return { name, coordinates: coords, interpolatedLat };
  });
}

const BOUNDARIES = parseBoundaries();

// Sorted south → north by lat at the initial center longitude
const SORTED_BOUNDARIES = [...BOUNDARIES].sort(
  (a, b) =>
    a.interpolatedLat(INITIAL_CENTER[0]) - b.interpolatedLat(INITIAL_CENTER[0]),
);

// Move camera N pixels along BEARING direction using explicit geographic displacement.
// This avoids the cardinal drift that panBy([0, delta]) causes on a rotated map.
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

  // Clamp to the lat range of the outermost boundaries — if clamped, suppress lng too
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

function findClosestBoundary(map: mapboxgl.Map): Boundary {
  const canvas = map.getCanvas();
  const w = canvas.width / devicePixelRatio;
  const h = canvas.height / devicePixelRatio;
  const center = map.unproject([w / 2, h / 2]);
  const centerLat = center.lat;
  const centerLng = center.lng;

  let closest = BOUNDARIES[0];
  let minDist = Infinity;
  for (const b of BOUNDARIES) {
    const dist = Math.abs(b.interpolatedLat(centerLng) - centerLat);
    if (dist < minDist) {
      minDist = dist;
      closest = b;
    }
  }
  return closest;
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingDeltaRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: "mapbox://styles/mapbox/dark-v11",
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      bearing: BEARING,
      interactive: false,
    });
    mapRef.current = map;

    function updateLabel(boundary: Boundary) {
      if (labelRef.current) labelRef.current.textContent = boundary.name;
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
      updateGlowLine(boundary);
      updateLabel(boundary);
      snapToBoundary(boundary);
    }

    function applyDelta(delta: number) {
      // Cancel any in-progress snap so it doesn't fight the new input
      map.stop();

      pendingDeltaRef.current += delta;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        panAlongBearing(map, pendingDeltaRef.current * SCROLL_SCALE);
        const closest = findClosestBoundary(map);
        updateGlowLine(closest);
        updateLabel(closest);
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

    map.on("load", () => {
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
          "line-opacity": 1.0,
        },
      });

      const houston =
        BOUNDARIES.find((b) => b.name === "Houston") ?? BOUNDARIES[0];
      updateGlowLine(houston);
      updateLabel(houston);
      snapToBoundary(houston);

      const container = containerRef.current!;
      container.addEventListener("wheel", onWheel, { passive: false });
      container.addEventListener("touchstart", onTouchStart, { passive: true });
      container.addEventListener("touchmove", onTouchMove, { passive: false });
    });

    return () => {
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
      <div ref={labelRef} className={styles.label} />
    </div>
  );
}
