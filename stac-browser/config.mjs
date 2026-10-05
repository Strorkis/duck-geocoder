// STAC Browser の設定 (build.sh が SB_CONFIG で渡す)。
// 既定値は STAC Browser の config.js。ここには変えるものだけを書く。
// catalogUrl と pathPrefix は配信先で変わるので、環境変数 (SB_catalogUrl / SB_pathPrefix) で渡す。
export default {
  // **外の STAC もこの画面の中で開く** (/external/...)。参照だけの Collection (AW3D30・NASA) は
  // 公開元の STAC を指していて、切っているとただのリンクになる。JAXA の置き場所は JSON を
  // binary/octet-stream で返すので、リンクで開くとダウンロードになってしまう。
  // 他の STAC も開けるようになるが、読むのは見ている人のブラウザで、こちらの負担は無い。
  allowExternalAccess: true,
  // GitHub Pages はサーバー側で経路を書き換えられないので、#/ の形にする
  // (history だと、Collection のページで再読み込みすると 404 になる)。
  historyMode: 'hash',
  // 説明文が日本語なので、画面も日本語から始める (ブラウザの言語が分かればそちらに従う)。
  locale: 'ja',
  // 項目が多い (PLATEAU は306都市)。カードだと1件が大きく、縦に長くなりすぎる。
  cardViewMode: 'list',
};
