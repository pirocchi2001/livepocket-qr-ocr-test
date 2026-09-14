'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import JSZip from 'jszip';
import {
  clearAllScanRecords,
  getAllScanRecords,
  LocalScanRecord,
} from '@/lib/local-store';

function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('ja-JP');
}

// ZIP内のファイル名は撮影日時のタイムスタンプそのものにする(例: 20260914_153012_045)。
// ミリ秒まで含めることで、短時間に連続してスキャンした場合でも重複しないようにしている。
function fileBaseName(record: LocalScanRecord): string {
  const d = new Date(record.capturedAt);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`
  );
}

function isMobileUserAgent(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export default function GalleryPage() {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [records, setRecords] = useState<LocalScanRecord[] | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isZipping, setIsZipping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function reload() {
    try {
      const all = await getAllScanRecords();
      setRecords(all);
    } catch (err) {
      console.error(err);
      setErrorText('保存済み画像の読み込みに失敗しました。');
    }
  }

  useEffect(() => {
    setIsMobile(isMobileUserAgent());
  }, []);

  useEffect(() => {
    void reload();
  }, []);

  // 各画像のサムネイル表示用URL(ページを離れる際に解放する)
  const thumbUrls = useMemo(() => {
    if (!records) return new Map<number, string>();
    const map = new Map<number, string>();
    for (const r of records) {
      map.set(r.id, URL.createObjectURL(r.imageBlob));
    }
    return map;
  }, [records]);

  useEffect(() => {
    return () => {
      thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [thumbUrls]);

  async function handleDownloadZip() {
    if (!records || records.length === 0) return;
    setIsZipping(true);
    setErrorText(null);
    try {
      const zip = new JSZip();
      const images = zip.folder('images');

      const summaryRows = ['id,capturedAt,rawText,imageFile'];
      for (const r of records) {
        const base = fileBaseName(r);
        const imageFile = `${base}.jpg`;
        images?.file(imageFile, r.imageBlob);

        const escapedRawText = `"${r.rawText.replace(/"/g, '""')}"`;
        summaryRows.push(
          [r.id, formatDateTime(r.capturedAt), escapedRawText, `images/${imageFile}`].join(',')
        );
      }
      zip.file('summary.csv', summaryRows.join('\n'));
      zip.file(
        'summary.json',
        JSON.stringify(
          records.map((r) => ({
            id: r.id,
            capturedAt: r.capturedAt,
            capturedAtText: formatDateTime(r.capturedAt),
            rawText: r.rawText,
            imageFile: `images/${fileBaseName(r)}.jpg`,
          })),
          null,
          2
        )
      );

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      a.href = url;
      a.download = `livepocket-scans_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
        now.getDate()
      )}_${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setErrorText('ZIPの作成に失敗しました。');
    } finally {
      setIsZipping(false);
    }
  }

  async function handleDeleteAll() {
    const ok = window.confirm(
      '端末内に保存されている画像をすべて削除します。この操作は取り消せません。よろしいですか?'
    );
    if (!ok) return;

    setIsDeleting(true);
    setErrorText(null);
    try {
      await clearAllScanRecords();
      await reload();
    } catch (err) {
      console.error(err);
      setErrorText('削除に失敗しました。');
    } finally {
      setIsDeleting(false);
    }
  }

  // 画像はスキャンした端末(スマホ)のIndexedDBにのみ保存されているため、
  // この管理画面もスマホでのアクセスのみを対象とする(PCでは何も保存されていない)。
  if (isMobile === null) {
    return null;
  }

  if (!isMobile) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-900 p-4 text-slate-100">
        <p className="max-w-sm text-center text-sm text-slate-400">
          この画面はスキャンを行ったスマートフォン上でのみご利用いただけます。
          画像は各端末内に保存されているため、PCからは確認できません。
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-900 p-4 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-bold">保存済み画像(この端末内)</h1>
          <Link href="/" className="text-sm text-emerald-400 hover:underline">
            スキャン画面に戻る
          </Link>
        </div>

        {errorText && <p className="mb-4 text-sm text-red-400">{errorText}</p>}

        {records === null && <p className="text-slate-400">読み込み中…</p>}

        {records !== null && (
          <>
            <p className="mb-4 text-sm text-slate-400">
              件数: {records.length}件(この端末に保存された分のみ表示しています)
            </p>

            <div className="mb-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleDownloadZip}
                disabled={records.length === 0 || isZipping}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isZipping ? 'ZIPを作成中…' : 'ZIPでダウンロード'}
              </button>
              <button
                type="button"
                onClick={handleDeleteAll}
                disabled={records.length === 0 || isDeleting}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? '削除中…' : '全て削除'}
              </button>
            </div>

            {records.length === 0 && (
              <p className="text-slate-400">まだ保存された画像はありません。</p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {records
                .slice()
                .reverse()
                .map((r) => (
                  <div
                    key={r.id}
                    className="overflow-hidden rounded-lg border border-slate-700 bg-slate-800"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbUrls.get(r.id)}
                      alt={`scan-${r.id}`}
                      className="aspect-[3/4] w-full object-cover"
                    />
                    <div className="p-2 text-xs">
                      <p className="truncate text-emerald-400" title={r.rawText}>
                        {r.rawText}
                      </p>
                      <p className="text-slate-400">{formatDateTime(r.capturedAt)}</p>
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
