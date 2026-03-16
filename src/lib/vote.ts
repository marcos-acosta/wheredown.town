import { db } from "./firebase";
import {
  doc,
  runTransaction,
  onSnapshot,
  collection,
  addDoc,
} from "firebase/firestore";

const TALLY_DOC = doc(db, "meta", "tally");
const VOTES_COLLECTION = collection(db, "votes");

const LOCAL_STORAGE_KEY = "downtown_vote";
const IS_TEST = process.env.NEXT_PUBLIC_ENV === "test";

export function getSavedVote(): number | null {
  if (IS_TEST) return null;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw !== null ? Number(raw) : null;
  } catch {
    return null;
  }
}

export async function submitVote(boundaryIndex: number): Promise<void> {
  if (!IS_TEST) localStorage.setItem(LOCAL_STORAGE_KEY, String(boundaryIndex));

  await addDoc(VOTES_COLLECTION, {
    boundaryIndex,
    timestamp: Date.now(),
  });

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(TALLY_DOC);
    if (!snap.exists()) {
      tx.set(TALLY_DOC, { counts: { [boundaryIndex]: 1 }, total: 1 });
    } else {
      const data = snap.data() as { counts: Record<string, number>; total: number };
      tx.update(TALLY_DOC, {
        [`counts.${boundaryIndex}`]: (data.counts[boundaryIndex] ?? 0) + 1,
        total: data.total + 1,
      });
    }
  });
}

export function subscribeToTally(
  callback: (counts: Record<string, number>, total: number) => void,
): () => void {
  return onSnapshot(TALLY_DOC, (snap) => {
    if (!snap.exists()) return;
    const { counts, total } = snap.data() as {
      counts: Record<string, number>;
      total: number;
    };
    callback(counts, total);
  });
}
