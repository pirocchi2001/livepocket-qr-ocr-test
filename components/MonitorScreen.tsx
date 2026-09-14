'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query, limit, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface ScanRow {
  id: string;
  rawText: string;
  scannedAt?: Timestamp;
}

function formatTime(ts?: Timestamp) {
  if (!ts) return '-';
  return ts.toDate().toLocaleTimeString('ja-JP');
}

export default function MonitorScreen() {
  const [rows, setRows] = useState<ScanRow[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'scans'), orderBy('scannedAt', 'desc'), limit(300));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const next: ScanRow[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          rawText: data.rawText ?? '',
          scannedAt: data.scannedAt,
        };
      });
      setRows(next);
    });
    return () => unsubscribe();
  }, []);

  return (
    <div className="mx-auto max-w-5xl p-6 text-slate-100">
      <h1 className="mb-4 text-xl font-bold">スキャンログ(QR読み取りテスト用・母艦画面)</h1>
      <p className="mb-4 text-sm text-slate-400">
        件数: {rows.length}件(直近300件まで表示・全端末のスキャン結果をリアルタイム表示)
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full min-w-[500px] text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="p-2">読み取り時刻</th>
              <th className="p-2">QRの内容</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-800">
                <td className="p-2 whitespace-nowrap">{formatTime(row.scannedAt)}</td>
                <td className="p-2 max-w-[400px] truncate" title={row.rawText}>
                  {row.rawText}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
