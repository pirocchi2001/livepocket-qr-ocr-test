import { createWorker, Worker } from 'tesseract.js';

// OCR認識に許可する文字種(英大文字+数字+空白)。
// 空白を許可しないと、画面内の無関係なテキスト(商品説明など)が単語の境界なく
// 連結されてしまい、誤って長い1つの塊として抽出される事故が起きるため、
// 単語の区切りを保つ目的で空白も許可している。
const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

// 手ブレなどによる1回ごとの失敗をカバーするため、複数枚を並行してOCRにかけ、
// 多数決で結果を決める。ここではワーカー(≒並行して処理できる数)を3つ用意する。
const WORKER_POOL_SIZE = 3;

// 複数枚まとめての処理に許容する合計の最大時間(ミリ秒)。
// これを超えたら、その時点までに得られた結果だけで多数決を行う。
export const OCR_TIME_BUDGET_MS = 1500;

let workerPoolPromise: Promise<Worker[]> | null = null;
let requestSeq = 0;

function getWorkerPool(): Promise<Worker[]> {
  if (!workerPoolPromise) {
    workerPoolPromise = (async () => {
      const workers = await Promise.all(
        Array.from({ length: WORKER_POOL_SIZE }, async () => {
          const worker = await createWorker('eng');
          await worker.setParameters({
            tessedit_char_whitelist: CHAR_WHITELIST,
            // 11 = sparse text。チケット画面のように文字が散らばったレイアウトで拾いやすい。
            tessedit_pageseg_mode: '11' as any,
          });
          return worker;
        })
      );
      return workers;
    })();
  }
  return workerPoolPromise;
}

// アプリ起動直後の初回スキャンでワーカー読み込み待ちにならないよう、事前に読み込んでおく
export function warmUpOcrWorker() {
  getWorkerPool().catch((err) => {
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

// 複数の抽出結果を項目ごとに多数決でまとめる。
// 例: [A907, A907, AS07] → seatNumberは"A907"(2票)を採用。
// 全部バラバラ(得票数が並ぶ、または全てnull)の場合はnull(未認識)のままにする。
export function combineByMajorityVote(results: OcrExtractedFields[]): OcrExtractedFields {
  function majority(values: (string | null)[]): string | null {
    const counts = new Map<string, number>();
    for (const v of values) {
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) return null;

    let best: string | null = null;
    let bestCount = 0;
    let tie = false;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) {
        tie = true;
      }
    }
    // 得票数が1票ずつで全員バラバラ(=最多得票が1)の場合は信頼できないため採用しない
    if (bestCount <= 1 && values.filter(Boolean).length > 1) return null;
    if (tie) return null;
    return best;
  }

  return {
    seatNumber: majority(results.map((r) => r.seatNumber)),
    applicationNumber: majority(results.map((r) => r.applicationNumber)),
  };
}

// 複数のキャンバス画像に対して並行してOCRを実行し、指定時間内に得られた結果だけで
// 多数決を行う。ワーカーはキャンバスの数だけ(最大プールサイズまで)並行して使う。
export async function recognizeMultiWithTimeout(
  canvases: HTMLCanvasElement[],
  timeoutMs: number = OCR_TIME_BUDGET_MS
): Promise<OcrExtractedFields> {
  if (canvases.length === 0) return EMPTY_FIELDS;

  const myRequestId = ++requestSeq;

  try {
    const workers = await getWorkerPool();

    const attempts = canvases.slice(0, workers.length).map((canvas, i) => {
      const worker = workers[i];
      const recognizePromise = worker
        .recognize(canvas)
        .then((result) => {
          if (myRequestId !== requestSeq) return null;
          return extractFields(result.data.text ?? '');
        })
        .catch((err) => {
          console.error('OCR処理中にエラーが発生しました(この1枚はスキップ)', err);
          return null;
        });

      // この1枚がtimeoutMsを超えたら、その1枚だけ諦めてnull扱いにする
      // (裏では処理が続くが、結果は使わない)
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      });

      return Promise.race([recognizePromise, timeoutPromise]);
    });

    const results = (await Promise.all(attempts)).filter(
      (v): v is OcrExtractedFields => !!v
    );

    return combineByMajorityVote(results);
  } catch (err) {
    console.error('OCR処理中にエラーが発生しました(スキップします)', err);
    return EMPTY_FIELDS;
  }
}
