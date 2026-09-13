'use client';

import { useEffect, useRef, useState } from 'react';
import jsQR, { QRCode } from 'jsqr';
import { recognizeMultiWithTimeout, warmUpOcrWorker, OcrExtractedFields } from '@/lib/ocr';
import { saveScan } from '@/lib/scans';
import { computeSeatNumberCropBox, CropBox } from '@/lib/qr-geometry';

const RESULT_DISPLAY_MS = 900;
const DETECTION_MAX_SIDE = 480; // QR検出用に縮小するサイズ(速度優先)
const CROP_UPSCALE_TARGET = 600; // 切り出した整理番号領域を、この幅程度まで拡大してからOCRする
const NUM_CAPTURES = 3; // 手ブレ対策として複数フレームを撮り、多数決で結果を決める枚数
const CAPTURE_INTERVAL_MS = 60; // 各フレームキャプチャの間隔
const SETTLE_DELAY_MS = 400; // QR検出後、実際の撮影までの「静止待ち」時間

type Phase = 'scanning' | 'holding' | 'processing' | 'result';

interface LastResult {
  rawText: string;
  ocr: OcrExtractedFields;
}

interface PercentPoint {
  x: number;
  y: number;
}

interface LockedOverlay {
  quadPercent: PercentPoint[]; // QRの四隅(0〜100の割合)
  seatBoxPercent: { x: number; y: number; width: number; height: number }; // 整理番号の推定読み取り範囲(0〜100の割合)
}

export default function QrScanner() {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [lockedOverlay, setLockedOverlay] = useState<LockedOverlay | null>(null);
  const [flashKey, setFlashKey] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isProcessingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    warmUpOcrWorker();
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

    // 検出したQRの位置に合わせて、ロックオン表示(緑の枠+読み取り範囲のハイライト)を表示する
    const toPercent = (p: { x: number; y: number }): PercentPoint => ({
      x: (p.x / detectionWidth) * 100,
      y: (p.y / detectionHeight) * 100,
    });
    const seatBoxDetectionSpace = computeSeatNumberCropBox(
      {
        topLeft: qr.location.topLeftCorner,
        topRight: qr.location.topRightCorner,
        bottomLeft: qr.location.bottomLeftCorner,
      },
      detectionWidth,
      detectionHeight
    );
    setLockedOverlay({
      quadPercent: [
        toPercent(qr.location.topLeftCorner),
        toPercent(qr.location.topRightCorner),
        toPercent(qr.location.bottomRightCorner),
        toPercent(qr.location.bottomLeftCorner),
      ],
      seatBoxPercent: {
        x: (seatBoxDetectionSpace.x / detectionWidth) * 100,
        y: (seatBoxDetectionSpace.y / detectionHeight) * 100,
        width: (seatBoxDetectionSpace.width / detectionWidth) * 100,
        height: (seatBoxDetectionSpace.height / detectionHeight) * 100,
      },
    });
    setFlashKey((k) => k + 1);

    try {
      // QR検出直後は手ブレ・オートフォーカスの途中であることが多いため、
      // 実際の撮影(OCR用のキャプチャ)は少し待ってから行う
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      setPhase('processing');

      const video = videoRef.current;
      let ocr: OcrExtractedFields = { seatNumber: null, applicationNumber: null };

      if (video && video.videoWidth > 0) {
        // 検出時の縮小画像 → 実際の映像解像度へのスケール比
        const scaleUp = video.videoWidth / detectionWidth;
        const toFullRes = (p: { x: number; y: number }) => ({
          x: p.x * scaleUp,
          y: p.y * scaleUp,
        });

        const corners = {
          topLeft: toFullRes(qr.location.topLeftCorner),
          topRight: toFullRes(qr.location.topRightCorner),
          bottomLeft: toFullRes(qr.location.bottomLeftCorner),
        };

        const cropBox = computeSeatNumberCropBox(corners, video.videoWidth, video.videoHeight);

        // 手ブレによる1回ごとの失敗をカバーするため、わずかに時間差をつけて複数枚キャプチャする
        const cropCanvases: HTMLCanvasElement[] = [];
        for (let i = 0; i < NUM_CAPTURES; i++) {
          const cropCanvas = renderCropCanvas(video, cropBox);
          if (cropCanvas) cropCanvases.push(cropCanvas);
          if (i < NUM_CAPTURES - 1) {
            await new Promise((resolve) => setTimeout(resolve, CAPTURE_INTERVAL_MS));
          }
        }

        if (cropCanvases.length > 0) {
          ocr = await recognizeMultiWithTimeout(cropCanvases);
        }
      }

      await saveScan(qr.data, ocr);
      setLastResult({ rawText: qr.data, ocr });
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

  function renderCropCanvas(video: HTMLVideoElement, box: CropBox): HTMLCanvasElement | null {
    if (!fullCanvasRef.current) {
      fullCanvasRef.current = document.createElement('canvas');
    }
    const fullCanvas = fullCanvasRef.current;
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    const fullCtx = fullCanvas.getContext('2d');
    if (!fullCtx) return null;
    fullCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);

    // 切り出した範囲を、OCRが読みやすい大きさまで拡大する(最大4倍まで)
    const upscale = Math.min(4, Math.max(1, CROP_UPSCALE_TARGET / Math.max(box.width, 1)));
    const outWidth = Math.max(1, Math.round(box.width * upscale));
    const outHeight = Math.max(1, Math.round(box.height * upscale));

    // 複数枚を並行してOCRにかけるため、呼び出すたびに新しいキャンバスを作る
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = outWidth;
    cropCanvas.height = outHeight;

    const ctx = cropCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(
      fullCanvas,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      outWidth,
      outHeight
    );

    applyGrayscaleContrastEnhancement(ctx, outWidth, outHeight);

    return cropCanvas;
  }

  // グレースケール化+コントラスト強調(ヒストグラムの最小・最大値で引き伸ばす)。
  function applyGrayscaleContrastEnhancement(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const grayValues = new Uint8ClampedArray(data.length / 4);

    let min = 255;
    let max = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      grayValues[p] = gray;
      if (gray < min) min = gray;
      if (gray > max) max = gray;
    }

    const range = Math.max(1, max - min);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const stretched = ((grayValues[p] - min) / range) * 255;
      data[i] = stretched;
      data[i + 1] = stretched;
      data[i + 2] = stretched;
    }

    ctx.putImageData(imageData, 0, 0);
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
            <div className="h-2/5 w-2/5 animate-pulse rounded-lg border-2 border-emerald-400/60" />
          </div>
        )}

        {/* ロックオン: 実際に検出したQRの四隅に合わせた枠+整理番号の読み取り範囲 */}
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
              strokeWidth={0.8}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={lockedOverlay.seatBoxPercent.x}
              y={lockedOverlay.seatBoxPercent.y}
              width={lockedOverlay.seatBoxPercent.width}
              height={lockedOverlay.seatBoxPercent.height}
              fill="rgba(251,191,36,0.25)"
              stroke="#fbbf24"
              strokeWidth={0.6}
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
        {phase === 'processing' && <p className="text-amber-300">読み取り中…</p>}
        {phase === 'result' && lastResult && (
          <div className="space-y-1 text-left text-sm">
            <p className="break-all text-emerald-400">読み取りました: {lastResult.rawText}</p>
            <p>整理番号: {lastResult.ocr.seatNumber ?? '(未認識)'}</p>
            <p>申込番号: {lastResult.ocr.applicationNumber ?? '(未認識)'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
