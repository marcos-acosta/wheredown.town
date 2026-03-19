import { db, auth } from "./firebase";
import {
  doc,
  getDoc,
  setDoc,
  runTransaction,
  onSnapshot,
} from "firebase/firestore";
import { signInAnonymously } from "firebase/auth";

const TALLY_DOC = doc(db, "meta", "tally");

const LOCAL_STORAGE_KEY = "downtown_vote";
export const IS_TEST = process.env.NEXT_PUBLIC_ENV === "test";

async function ensureAuth(): Promise<string> {
  if (auth.currentUser) return auth.currentUser.uid;
  const { user } = await signInAnonymously(auth);
  return user.uid;
}

export function getSavedVote(): number | null {
  if (IS_TEST) return null; // ignore saved vote in test mode so voting can be repeated
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw !== null ? Number(raw) : null;
  } catch {
    return null;
  }
}

export async function submitVote(boundaryIndex: number): Promise<void> {
  localStorage.setItem(LOCAL_STORAGE_KEY, String(boundaryIndex));

  const uid = await ensureAuth();

  // setDoc with UID as document ID — Firestore rules enforce one create per UID
  await setDoc(doc(db, "votes", uid), {
    boundaryIndex,
    timestamp: Date.now(),
  });

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(TALLY_DOC);
    if (!snap.exists()) {
      tx.set(TALLY_DOC, { counts: { [boundaryIndex]: 1 }, total: 1 });
    } else {
      const data = snap.data() as {
        counts: Record<string, number>;
        total: number;
      };
      tx.update(TALLY_DOC, {
        [`counts.${boundaryIndex}`]: (data.counts[boundaryIndex] ?? 0) + 1,
        total: data.total + 1,
      });
    }
  });
}

export async function fetchTallyOnce(): Promise<{
  counts: Record<string, number>;
  total: number;
} | null> {
  const snap = await getDoc(TALLY_DOC);
  if (!snap.exists()) return null;
  return snap.data() as { counts: Record<string, number>; total: number };
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
