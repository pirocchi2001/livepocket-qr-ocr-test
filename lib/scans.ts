import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export async function saveScan(rawText: string) {
  await addDoc(collection(db, 'scans'), {
    scannedAt: serverTimestamp(),
    rawText: rawText.slice(0, 2000),
  });
}
