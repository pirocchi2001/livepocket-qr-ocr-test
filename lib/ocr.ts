import { createWorker, Worker } from 'tesseract.js';

// OCR認識に許可する文字種(英大文字+数字のみ。誤認識抑制と速度向上のため)
const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// 1回のOCR処理に許容する最大時間(ミリ秒)。これを超えたら結果を破棄してスキップ扱いにする。
export const OCR_TIME_BUDGET_MS = 1200;

let workerPromise: Promise<Worker> | null = null;
let requestSeq = 0;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: CHAR_WHITELIST,
        // 6 = 均一なテキストブロックとして扱う。チケット画面のようにテキストが
        // 散らばったレイアウトの場合は 11(sparse text)の方が拾いやすいことが多い。
        tessedit_pageseg_mode: '11' as any,
      });
      return worker;
    })();
  }
  return workerPromise;
}

// アプリ起動直後の初回スキャンでワーカー読み込み待ちにならないよう、事前に読み込んでおく
export function warmUpOcrWorker() {
  getWorker().catch((err) => {
    console.error('OCRワーカーの初期化に失敗しました', err);
  });
}

export interface OcrExtractedFields {
  seatNumber: string | null; // 整理番号
  ticketNumber: string | null; // チケット番号
  applicationNumber: string | null; // 申込番号
}

const EMPTY_FIELDS: OcrExtractedFields = {
  seatNumber: null,
  ticketNumber: null,
  applicationNumber: null,
};

// 認識済みテキスト全体から、パターンに基づいて3項目を抽出する。
// 各項目は独立して探すため、どれか1つだけ見つかる場合もある。
export function extractFields(rawOcrText: string): OcrExtractedFields {
  const text = rawOcrText.toUpperCase();
  const tokens = text.match(/[A-Z0-9]+/g) ?? [];

  let seatNumber: string | null = null;
  let ticketNumber: string | null = null;
  let applicationNumber: string | null = null;

  for (const token of tokens) {
    // チケット番号: 英数字混在で15〜30文字程度の長い塊
    if (!ticketNumber && token.length >= 15 && token.length <= 30) {
      ticketNumber = token;
      continue;
    }
    // 申込番号: 数字のみ9〜12桁
    if (!applicationNumber && /^\d{9,12}$/.test(token)) {
      applicationNumber = token;
      continue;
    }
    // 整理番号: 英字1〜2文字+数字2〜5桁、の短い塊(例: A907)
    if (!seatNumber && /^[A-Z]{1,2}\d{2,5}$/.test(token)) {
      seatNumber = token;
      continue;
    }
  }

  return { seatNumber, ticketNumber, applicationNumber };
}

// キャンバス画像に対してOCRを実行し、指定時間内に終わらなければnullを返す(スキップ扱い)。
// タイムアウト後もワーカー内部の処理は裏で継続させ、結果は破棄する(次回以降に影響しないようリクエストIDで管理)。
export async function recognizeWithTimeout(
  canvas: HTMLCanvasElement,
  timeoutMs: number = OCR_TIME_BUDGET_MS
): Promise<OcrExtractedFields> {
  const myRequestId = ++requestSeq;

  try {
    const worker = await getWorker();

    const recognizePromise = worker.recognize(canvas).then((result) => {
      // 自分より後の新しいリクエストが発行済みなら、結果は使わない
      if (myRequestId !== requestSeq) {
        return EMPTY_FIELDS;
      }
      return extractFields(result.data.text ?? '');
    });

    const timeoutPromise = new Promise<OcrExtractedFields>((resolve) => {
      setTimeout(() => resolve(EMPTY_FIELDS), timeoutMs);
    });

    return await Promise.race([recognizePromise, timeoutPromise]);
  } catch (err) {
    console.error('OCR処理中にエラーが発生しました(スキップします)', err);
    return EMPTY_FIELDS;
  }
}
