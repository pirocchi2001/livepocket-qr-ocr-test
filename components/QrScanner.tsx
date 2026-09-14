'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import jsQR, { QRCode } from 'jsqr';
import { saveScan } from '@/lib/scans';
import { addScanRecord } from '@/lib/local-store';

const RESULT_DISPLAY_MS = 900;
const DETECTION_MAX_SIDE = 480; // QR検出用に縮小するサイズ(速度優先)
const SETTLE_DELAY_MS = 400; // QR検出後、実際の撮影までの「静止待ち」時間
const CAPTURE_MAX_SIDE = 900; // 保存する画像の長辺サイズ
const CAPTURE_JPEG_QUALITY = 0.6;

type Phase = 'scanning' | 'holding' | 'processing' | 'result';

interface LastResult {
  rawText: string;
}

interface PercentPoint {
  x: number;
  y: number;
}

interface LockedOverlay {
  quadPercent: PercentPoint[]; // QRの四隅(0〜100の割合)
}

export default function QrScanner() {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [lockedOverlay, setLockedOverlay] = useState<LockedOverlay | null>(null);
  const [flashKey, setFlashKey] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isProcessingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setErrorText('カメラを起動できませんでした。カメラの使用許可を確認してください。');
        console.error(err);
      }
    }

    function tick() {
      if (!isProcessingRef.current) {
        scanFrame();
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scanFrame() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const dWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const dHeight = Math.max(1, Math.round(video.videoHeight * scale));

    if (!detectionCanvasRef.current) {
      detectionCanvasRef.current = document.createElement('canvas');
    }
    const dCanvas = detectionCanvasRef.current;
    dCanvas.width = dWidth;
    dCanvas.height = dHeight;
    const dCtx = dCanvas.getContext('2d', { willReadFrequently: true });
    if (!dCtx) return;
    dCtx.drawImage(video, 0, 0, dWidth, dHeight);

    let imageData: ImageData;
    try {
      imageData = dCtx.getImageData(0, 0, dWidth, dHeight);
    } catch {
      return;
    }

    const result = jsQR(imageData.data, dWidth, dHeight, {
      inversionAttempts: 'dontInvert',
    });

    if (result && result.data) {
      void handleScanSuccess(result, dWidth, dHeight);
    }
  }

  async function handleScanSuccess(qr: QRCode, detectionWidth: number, detectionHeight: number) {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setPhase('holding');

    // 検出したQRの位置に合わせて、ロックオン表示(緑の枠)を表示する
    const toPercent = (p: { x: number; y: number }): PercentPoint => ({
      x: (p.x / detectionWidth) * 100,
      y: (p.y / detectionHeight) * 100,
    });
    setLockedOverlay({
      quadPercent: [
        toPercent(qr.location.topLeftCorner),
        toPercent(qr.location.topRightCorner),
        toPercent(qr.location.bottomRightCorner),
        toPercent(qr.location.bottomLeftCorner),
      ],
    });
    setFlashKey((k) => k + 1);

    try {
      // QR検出直後は手ブレ・オートフォーカスの途中であることが多いため、
      // 実際の撮影(保存用のキャプチャ)は少し待ってから行う
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      setPhase('processing');

      const video = videoRef.current;
      if (video && video.videoWidth > 0) {
        const blob = await captureResizedJpeg(video);
        if (blob) {
          await addScanRecord(qr.data, Date.now(), blob);
        }
      }

      await saveScan(qr.data);
      setLastResult({ rawText: qr.data });
      setPhase('result');

      setTimeout(() => {
        setPhase('scanning');
        setLockedOverlay(null);
        isProcessingRef.current = false;
      }, RESULT_DISPLAY_MS);
    } catch (err) {
      console.error('スキャン処理中にエラーが発生しました', err);
      setErrorText('記録に失敗しました。通信状況を確認してください。');
      setPhase('scanning');
      setLockedOverlay(null);
      isProcessingRef.current = false;
    }
  }

  // カメラのフル画面フレームを1枚キャプチャし、長辺 CAPTURE_MAX_SIDE 程度にリサイズして
  // JPEG化する(あとで人間が目視確認するための保存用画像)。
  function captureResizedJpeg(video: HTMLVideoElement): Promise<Blob | null> {
    const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const outWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const outHeight = Math.max(1, Math.round(video.videoHeight * scale));

    if (!captureCanvasRef.current) {
      captureCanvasRef.current = document.createElement('canvas');
    }
    const canvas = captureCanvasRef.current;
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(video, 0, 0, outWidth, outHeight);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', CAPTURE_JPEG_QUALITY);
    });
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-sm overflow-hidden rounded-xl border border-slate-700 bg-black">
        <video
          ref={videoRef}
          className="w-full"
          autoPlay
          muted
          playsInline
        />

        {/* 探索中: 呼吸するようにパルスするガイド枠(まだQRが見つかっていない間だけ表示) */}
        {!lockedOverlay && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-2/5 w-2/5 animate-pulse rounded-lg border-4 border-emerald-400" />
          </div>
        )}

        {/* ロックオン: 実際に検出したQRの四隅に合わせた枠 */}
        {lockedOverlay && (
          <svg
            key={flashKey}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className={`qr-lock-flash pointer-events-none absolute inset-0 h-full w-full ${
              phase === 'holding' ? 'animate-pulse' : ''
            }`}
          >
            <polygon
              points={lockedOverlay.quadPercent.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={phase === 'holding' ? '#fbbf24' : '#34d399'}
              strokeWidth={2.2}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>

      {errorText && <p className="text-sm text-red-400">{errorText}</p>}

      <div className="w-full max-w-sm rounded-xl bg-slate-800 p-4 text-center text-slate-100">
        {phase === 'scanning' && <p className="text-slate-400">QRコードをかざしてください</p>}
        {phase === 'holding' && (
          <p className="font-medium text-amber-300">そのまま動かさないでください…</p>
        )}
        {phase === 'processing' && <p className="text-amber-300">保存中…</p>}
        {phase === 'result' && lastResult && (
          <div className="space-y-1 text-left text-sm">
            <p className="break-all text-emerald-400">読み取りました: {lastResult.rawText}</p>
            <p className="text-slate-400">画像を端末に保存しました</p>
          </div>
        )}
      </div>

      <Link
        href="/gallery"
        className="w-full max-w-sm rounded-xl bg-slate-700 p-3 text-center text-sm font-medium text-slate-100 hover:bg-slate-600"
      >
        保存した画像を見る
      </Link>
    </div>
  );
}
