import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import type { OcrExtractedFields } from './ocr';

export async function saveScan(rawText: string, ocr: OcrExtractedFields) {
  const data: Record<string, unknown> = {
    scannedAt: serverTimestamp(),
    rawText: rawText.slice(0, 2000),
  };
  // 認識できなかった項目はキー自体を含めない(FirestoreルールのhasOnly判定に合わせる)
  if (ocr.seatNumber) data.ocrSeatNumber = ocr.seatNumber;
  if (ocr.applicationNumber) data.ocrApplicationNumber = ocr.applicationNumber;

  await addDoc(collection(db, 'scans'), data);
}
