// STAC Browser の背景地図。build.sh が STAC Browser のソースの basemaps.config.js を置き換える。
//
// **既定の OpenStreetMap の公式タイルを使わない。** OSM のタイルサーバーはボランティアの
// 寄付で動いていて、利用方針で重い使い方を禁じている。アプリ本体と同じ地理院タイル
// (出典を出せば使える) にそろえる。カタログは地球のものだけなので、天体ごとの切り替えは持たない。

/**
 * @returns {Array.<Object>} OpenLayers の背景地図の設定
 */
export default function configureBasemap() {
  return [
    {
      // **標準地図にする。** 淡色地図と航空写真はズーム2からしか無く (0・1 は 404)、
      // 全球の Collection (AW3D30・NASA) を引いた表示で開くと地図が真っ白になる。
      url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
      is: 'XYZ',
      title: '地理院タイル (標準地図)',
      attributions: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
      projection: 'EPSG:3857',
      maxZoom: 18,
    },
  ];
}
