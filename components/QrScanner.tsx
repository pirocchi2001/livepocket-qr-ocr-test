'use client';

import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { recognizeWithTimeout, warmUpOcrWorker, OcrExtractedFields } from '@/lib/ocr';
import { saveScan } from '@/lib/scans';

const READER_ELEMENT_ID = 'qr-reader-region';
const RESULT_DISPLAY_MS = 900;

type Phase = 'scanning' | 'processing' | 'result';

interface LastResult {
  rawText: string;
  ocr: OcrExtractedFields;
}

export default function QrScanner() {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const isProcessingRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    warmUpOcrWorker();

    const html5QrCode = new Html5Qrcode(READER_ELEMENT_ID);
    html5QrCodeRef.current = html5QrCode;

    html5QrCode
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        (decodedText) => {
          void handleScanSuccess(decodedText);
        },
        () => {
          // デコード失敗は毎フレーム起こり得るため無視する
        }
      )
      .catch((err) => {
        setErrorText('カメラを起動できませんでした。カメラの使用許可を確認してください。');
        console.error(err);
      });

    return () => {
      html5QrCode
        .stop()
        .then(() => html5QrCode.clear())
        .catch(() => {
          /* すでに停止している場合は無視 */
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleScanSuccess(decodedText: string) {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setPhase('processing');

    try {
      const frame = captureVideoFrame();
      const ocr = frame
        ? await recognizeWithTimeout(frame)
        : { seatNumber: null, ticketNumber: null, applicationNumber: null };

      await saveScan(decodedText, ocr);

      setLastResult({ rawText: decodedText, ocr });
      setPhase('result');

      setTimeout(() => {
        setPhase('scanning');
        isProcessingRef.current = false;
      }, RESULT_DISPLAY_MS);
    } catch (err) {
      console.error('スキャン処理中にエラーが発生しました', err);
      setErrorText('記録に失敗しました。通信状況を確認してください。');
      setPhase('scanning');
      isProcessingRef.current = false;
    }
  }

  function captureVideoFrame(): HTMLCanvasElement | null {
    const container = document.getElementById(READER_ELEMENT_ID);
    const video = container?.querySelector('video') as HTMLVideoElement | null;
    if (!video || video.videoWidth === 0) return null;

    // 処理速度のため長辺800px程度に縮小する
    const maxSide = 800;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        id={READER_ELEMENT_ID}
        className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-700"
      />

      {errorText && <p className="text-sm text-red-400">{errorText}</p>}

      <div className="w-full max-w-sm rounded-xl bg-slate-800 p-4 text-center text-slate-100">
        {phase === 'scanning' && <p className="text-slate-400">QRコードをかざしてください</p>}
        {phase === 'processing' && <p className="text-amber-300">読み取り中…</p>}
        {phase === 'result' && lastResult && (
          <div className="space-y-1 text-left text-sm">
            <p className="break-all text-emerald-400">読み取りました: {lastResult.rawText}</p>
            <p>整理番号: {lastResult.ocr.seatNumber ?? '(未認識)'}</p>
            <p>チケット番号: {lastResult.ocr.ticketNumber ?? '(未認識)'}</p>
            <p>申込番号: {lastResult.ocr.applicationNumber ?? '(未認識)'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
