export interface Point {
  x: number;
  y: number;
}

export interface QrCorners {
  topLeft: Point;
  topRight: Point;
  bottomLeft: Point;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 実際のLivePocketチケット画面のスクリーンショットを解析して算出した、
// QRコードの左上を原点(0,0)、QRの右方向ベクトル・下方向ベクトルを単位(1,1)とした
// 座標系での「整理番号」テキストのおおよその位置。
// (QR幅484px・整理番号ボックス x:143-295, y:2157-2206 の実測値から算出)
const SEAT_NUMBER_REGION = {
  left: -0.467,
  top: 2.959,
  width: 0.314,
  height: 0.101,
};

// 実機ごとのブレ(チケットデザインの微差、検出座標の誤差、ユーザーの構え方の違い)を
// 吸収するために、上記の範囲の外側に余白を追加する(各辺、幅・高さの50%分ずつ広げる)。
const PADDING_RATIO = 0.5;

// QRコードの実際の検出座標(4隅のうち3点)から、整理番号が写っていると推定される
// 矩形(軸並行のバウンディングボックス)を計算する。
// QRの右方向ベクトル・下方向ベクトルを基準に計算するため、多少の回転・傾きにも追従できる。
export function computeSeatNumberCropBox(
  corners: QrCorners,
  imageWidth: number,
  imageHeight: number
): CropBox {
  const right: Point = {
    x: corners.topRight.x - corners.topLeft.x,
    y: corners.topRight.y - corners.topLeft.y,
  };
  const down: Point = {
    x: corners.bottomLeft.x - corners.topLeft.x,
    y: corners.bottomLeft.y - corners.topLeft.y,
  };

  const left = SEAT_NUMBER_REGION.left - SEAT_NUMBER_REGION.width * PADDING_RATIO;
  const top = SEAT_NUMBER_REGION.top - SEAT_NUMBER_REGION.height * PADDING_RATIO;
  const width = SEAT_NUMBER_REGION.width * (1 + PADDING_RATIO * 2);
  const height = SEAT_NUMBER_REGION.height * (1 + PADDING_RATIO * 2);

  const relativeCorners = [
    { rx: left, ry: top },
    { rx: left + width, ry: top },
    { rx: left, ry: top + height },
    { rx: left + width, ry: top + height },
  ];

  const absoluteCorners = relativeCorners.map(({ rx, ry }) => ({
    x: corners.topLeft.x + rx * right.x + ry * down.x,
    y: corners.topLeft.y + rx * right.y + ry * down.y,
  }));

  const xs = absoluteCorners.map((p) => p.x);
  const ys = absoluteCorners.map((p) => p.y);

  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(imageWidth, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(imageHeight, Math.max(...ys));

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}
