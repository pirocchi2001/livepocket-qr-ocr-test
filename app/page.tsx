'use client';

import { useEffect, useState } from 'react';
import QrScanner from '@/components/QrScanner';
import MonitorScreen from '@/components/MonitorScreen';

function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function Home() {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
  }, []);

  if (isMobile === null) {
    return null;
  }

  if (isMobile) {
    return (
      <main className="min-h-screen bg-slate-900 p-4">
        <h1 className="mb-4 text-center text-lg font-bold text-slate-100">
          QR+OCR 読み取りテスト
        </h1>
        <QrScanner />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-900">
      <MonitorScreen />
    </main>
  );
}
