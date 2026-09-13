import { createWorker, Worker } from 'tesseract.js';

// OCR認識に許可する文字種(英大文字+数字+空白)。
// 空白を許可しないと、画面内の無関係なテキスト(商品説明など)が単語の境界なく
// 連結されてしまい、誤って長い1つの塊として抽出される事故が起きるため、
// 単語の区切りを保つ目的で空白も許可している。
const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

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
  applicationNumber: string | null; // 申込番号
}

const EMPTY_FIELDS: OcrExtractedFields = {
  seatNumber: null,
  applicationNumber: null,
};

// 認識済みテキスト全体から、パターンに基づいて項目を抽出する。
export function extractFields(rawOcrText: string): OcrExtractedFields {
  const text = rawOcrText.toUpperCase();
  const tokens = text.match(/[A-Z0-9]+/g) ?? [];

  let seatNumber: string | null = null;
  let applicationNumber: string | null = null;

  for (const token of tokens) {
    // 申込番号: 数字のみ9〜12桁
    if (!applicationNumber && /^\d{9,12}$/.test(token)) {
      applicationNumber = token;
      continue;
    }
    // 整理番号: 英字1〜2文字+数字2〜5桁、の短い塊(例: A907)。
    // チケット画面内では、整理番号は商品説明文(誤読の元になりやすい日付・時間表記を含む)
    // より後ろに表示されるため、最初に見つかった候補ではなく「最後に見つかった候補」を
    // 採用することで、説明文由来の誤検出を拾いにくくしている。
    if (/^[A-Z]{1,2}\d{2,5}$/.test(token)) {
      seatNumber = token;
      continue;
    }
  }

  return { seatNumber, applicationNumber };
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
