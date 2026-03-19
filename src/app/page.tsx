"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import Intro from "@/components/Intro";
import {
  submitVote,
  fetchTallyOnce,
  subscribeToTally,
  getSavedVote,
  IS_TEST,
} from "@/lib/vote";
import { RegionShare } from "@/lib/types";
import boundariesData from "@/data/boundaries";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

type Phase = "intro" | "map" | "results";

// Returns N+1 entries where entry i represents the region between boundary[i-1] and boundary[i].
// Entry 0 = south of the first boundary (always 100% downtown).
// Entry N = north of the last boundary (always 0%).
// A voter who picks boundary B considers all regions with index <= B to be downtown.
function buildRegionShares(
  counts: Record<string, number>,
  total: number,
): RegionShare[] {
  const n = (boundariesData as GeoJSON.FeatureCollection).features.length;
  // suffix sum: suffixVotes[i] = number of voters who picked boundary >= i
  const suffixVotes = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixVotes[i] = (counts[i] ?? 0) + suffixVotes[i + 1];
  }
  return Array.from({ length: n + 1 }, (_, i) => ({
    number: suffixVotes[i],
    percent: total > 0 ? suffixVotes[i] / total : 0,
  }));
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [regionShares, setRegionShares] = useState<RegionShare[]>([]);
  const [userBoundaryIndex, setUserBoundaryIndex] = useState<number | null>(null);

  useEffect(() => {
    const saved = getSavedVote();
    if (saved !== null) {
      setUserBoundaryIndex(saved);
      setPhase("results");
    }
  }, []);

  useEffect(() => {
    if (phase !== "results") return;
    const unsubscribe = subscribeToTally((counts, total) => {
      const regions = buildRegionShares(counts, total);
      setRegionShares(regions);
      if (IS_TEST) console.log(regions);
    });
    return unsubscribe;
  }, [phase]);

  async function handleVote(boundaryIndex: number) {
    setUserBoundaryIndex(boundaryIndex);
    await submitVote(boundaryIndex);
    const tally = await fetchTallyOnce();
    if (tally) setRegionShares(buildRegionShares(tally.counts, tally.total));
    setPhase("results");
  }

  if (phase === "intro") return <Intro onStart={() => setPhase("map")} />;
  return (
    <MapView
      onVote={handleVote}
      voted={phase === "results"}
      regionShares={regionShares}
      userBoundaryIndex={userBoundaryIndex}
    />
  );
}
