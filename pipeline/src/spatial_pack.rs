use anyhow::{Result, bail};
use std::cmp::Ordering;

/// 地物の外接矩形。並べ替えの計算にしか使わないので、ジオメトリ本体は持たない。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub xmin: f64,
    pub ymin: f64,
    pub xmax: f64,
    pub ymax: f64,
}

impl Bbox {
    fn center_x(&self) -> f64 {
        (self.xmin + self.xmax) / 2.0
    }

    fn center_y(&self) -> f64 {
        (self.ymin + self.ymax) / 2.0
    }

    fn width(&self) -> f64 {
        self.xmax - self.xmin
    }

    fn height(&self) -> f64 {
        self.ymax - self.ymin
    }

    fn is_finite(&self) -> bool {
        self.xmin.is_finite() && self.ymin.is_finite() && self.xmax.is_finite() && self.ymax.is_finite()
    }
}

/// row group 1個あたりの目標バイト数。
///
/// row groupは統計で読み飛ばす単位であると同時に、読むときの最小単位でもある。
/// 大きすぎると1点を調べるだけで無関係な地物を大量に読むことになり、
/// 小さすぎるとrow groupごとの統計が増えてフッターが肥大する
/// (フッターはファイルを開くたびに全部読まれる)。
const TARGET_ROW_GROUP_BYTES: usize = 2 * 1024 * 1024;

/// row groupあたりの行数の上限。点データのように1行が極端に小さい場合に、
/// row groupが1個だけになってしまうのを防ぐ。
const MAX_ROW_GROUP_SIZE: usize = 100_000;

/// row groupの個数の上限。
///
/// row groupごとの統計はフッターに入り、フッターはファイルを開くたびに
/// 全部読まれる。数が増えすぎると、開くだけで待たされるようになる。
/// 「1 row groupあたり何行以上」という形ではこれを表現できない
/// (1行が重いデータでは、少ない行数でも十分な大きさになる) ので、個数で抑える。
const MAX_ROW_GROUPS: usize = 2_000;

/// ファイルサイズと行数から、row groupあたりの行数を決める。
///
/// 1行あたりのバイト数はデータセットによって3桁ほど違う
/// (Overtureの行政区域は約43KB/行、位置参照情報の点は約40バイト/行) ので、
/// 行数で固定するとどれかが必ず不適切になる。
pub fn default_row_group_size(file_bytes: u64, num_rows: usize) -> usize {
    if num_rows == 0 {
        return 1;
    }
    let bytes_per_row = (file_bytes as usize).div_ceil(num_rows).max(1);
    let by_bytes = (TARGET_ROW_GROUP_BYTES / bytes_per_row).clamp(1, MAX_ROW_GROUP_SIZE);
    by_bytes.max(num_rows.div_ceil(MAX_ROW_GROUPS))
}

/// STR (Sort-Tile-Recursive) バルクロードで、空間的に近い地物が同じrow groupに
/// 入るような行の並び順を返す。返るのは元の行番号の並べ替え。
///
/// row groupを読み飛ばせるかどうかは、Parquetがrow group単位で持つ
/// bbox列のmin/max統計で決まる。変換直後のファイルは元データの並び順のままなので、
/// どのrow groupのbboxも日本全体に広がってしまい、統計が何も絞り込めない。
/// 近いものを同じrow groupに集めておくと、統計が狭くなり、
/// HTTP越しに読むときに関係ないrow groupを取りに行かずに済む。
pub fn pack(bboxes: &[Bbox], row_group_size: usize) -> Result<Vec<u32>> {
    if row_group_size == 0 {
        bail!("row group size must be greater than 0");
    }
    if bboxes.len() > u32::MAX as usize {
        bail!("too many rows to pack: {}", bboxes.len());
    }
    if let Some(index) = bboxes.iter().position(|b| !b.is_finite()) {
        bail!("row {index} has a non-finite bbox: {:?}", bboxes[index]);
    }

    let mut order: Vec<u32> = (0..bboxes.len() as u32).collect();
    pack_recursive(&mut order, bboxes, row_group_size);
    Ok(order)
}

fn pack_recursive(rows: &mut [u32], bboxes: &[Bbox], row_group_size: usize) {
    if rows.len() <= row_group_size {
        return;
    }

    // 長い方の軸で切る。常に同じ軸で切ると細長いrow groupができて、
    // 短い方の軸の統計が絞り込みに効かなくなる。
    let extent = extent_of(rows, bboxes);
    let split_x = extent.width() >= extent.height();
    let key = |row: &u32| {
        let bbox = &bboxes[*row as usize];
        if split_x { bbox.center_x() } else { bbox.center_y() }
    };
    // bboxが有限であることは pack() で確認済みなので、比較は必ず成立する。
    rows.sort_unstable_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(Ordering::Equal));

    // row groupの境界で分ける。こうすると、末尾以外のrow groupは
    // 必ずちょうど row_group_size 行になる。
    let leaves = rows.len().div_ceil(row_group_size);
    let split_at = (leaves / 2).max(1) * row_group_size;
    let (left, right) = rows.split_at_mut(split_at);
    pack_recursive(left, bboxes, row_group_size);
    pack_recursive(right, bboxes, row_group_size);
}

fn extent_of(rows: &[u32], bboxes: &[Bbox]) -> Bbox {
    rows.iter().fold(
        Bbox {
            xmin: f64::INFINITY,
            ymin: f64::INFINITY,
            xmax: f64::NEG_INFINITY,
            ymax: f64::NEG_INFINITY,
        },
        |acc, row| {
            let bbox = &bboxes[*row as usize];
            Bbox {
                xmin: acc.xmin.min(bbox.xmin),
                ymin: acc.ymin.min(bbox.ymin),
                xmax: acc.xmax.max(bbox.xmax),
                ymax: acc.ymax.max(bbox.ymax),
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> Bbox {
        Bbox {
            xmin: x,
            ymin: y,
            xmax: x,
            ymax: y,
        }
    }

    /// 10x10の格子。row group 25行なら、理想的には5x5のブロック4つに分かれる。
    fn grid() -> Vec<Bbox> {
        (0..10)
            .flat_map(|x| (0..10).map(move |y| point(x as f64, y as f64)))
            .collect()
    }

    fn row_group_extents(order: &[u32], bboxes: &[Bbox], row_group_size: usize) -> Vec<Bbox> {
        order
            .chunks(row_group_size)
            .map(|chunk| extent_of(chunk, bboxes))
            .collect()
    }

    // 実データの実測値。1行あたりのバイト数が桁違いでも、
    // row group 1個の大きさが目標付近に収まること。
    #[test]
    fn derives_row_group_size_from_bytes_per_row() {
        let datasets = [
            ("行政区域 Overture (全国)", 78_700_000u64, 1_741usize),
            ("行政区域 N03 (全国)", 259_927_901, 125_130),
            ("街区 (神奈川県)", 24_718_663, 571_233),
            ("建物 (港区)", 3_213_930, 24_345),
        ];

        for (name, file_bytes, num_rows) in datasets {
            let size = default_row_group_size(file_bytes, num_rows);
            let row_group_bytes = size as u64 * file_bytes / num_rows as u64;
            assert!(
                (TARGET_ROW_GROUP_BYTES as u64 / 2..=TARGET_ROW_GROUP_BYTES as u64)
                    .contains(&row_group_bytes),
                "{name}: row group が {row_group_bytes} バイト ({size} 行)",
            );
        }
    }

    // 1行が重いデータほど、row groupに入る行数は少なくなる。
    #[test]
    fn heavier_rows_get_fewer_rows_per_row_group() {
        let admin = default_row_group_size(259_927_901, 125_130);
        let block = default_row_group_size(24_718_663, 571_233);
        assert!(admin < block, "行政区域 {admin} 行 < 街区 {block} 行");
    }

    #[test]
    fn keeps_row_groups_large_enough_when_rows_are_tiny() {
        // 1行が極端に軽くても、row groupあたりの行数には上限を置く。
        assert_eq!(default_row_group_size(1_000, 1_000_000), MAX_ROW_GROUP_SIZE);
    }

    // 1行が重いデータでは行数が少なくなるが、row groupの個数が増えすぎると
    // フッターが肥大してファイルを開くのが遅くなる。個数の側で歯止めをかける。
    #[test]
    fn caps_the_number_of_row_groups() {
        // 1行10MBのデータを100万行。バイト数だけで決めると1行1 row groupになる。
        let size = default_row_group_size(10_000_000_000_000, 1_000_000);
        assert_eq!(1_000_000usize.div_ceil(size), MAX_ROW_GROUPS);
    }

    #[test]
    fn handles_empty_file() {
        assert_eq!(default_row_group_size(0, 0), 1);
    }

    #[test]
    fn returns_a_permutation_of_all_rows() {
        let bboxes = grid();
        let mut order = pack(&bboxes, 25).unwrap();
        order.sort_unstable();
        assert_eq!(order, (0..100u32).collect::<Vec<_>>());
    }

    // これがこのモジュールの目的そのもの。並べ替えた結果、各row groupの範囲が
    // 全体の1/2 x 1/2 に収まっていなければ、統計による絞り込みは効かない。
    #[test]
    fn packs_a_grid_into_compact_row_groups() {
        let bboxes = grid();
        let order = pack(&bboxes, 25).unwrap();

        let extents = row_group_extents(&order, &bboxes, 25);
        assert_eq!(extents.len(), 4);
        for extent in extents {
            assert!(extent.width() <= 4.0, "row group が横に広すぎる: {extent:?}");
            assert!(extent.height() <= 4.0, "row group が縦に広すぎる: {extent:?}");
        }
    }

    // 並べ替え前 (格子をx優先で作った順) は、各row groupが縦に細長くなる。
    // つまりテストの格子は「最初から詰まっている」わけではない。
    #[test]
    fn unpacked_order_is_not_already_compact() {
        let bboxes = grid();
        let identity: Vec<u32> = (0..100u32).collect();

        let extents = row_group_extents(&identity, &bboxes, 25);
        assert!(extents.iter().any(|e| e.height() > 4.0));
    }

    #[test]
    fn keeps_order_when_everything_fits_in_one_row_group() {
        let bboxes = grid();
        let order = pack(&bboxes, 100).unwrap();
        assert_eq!(order, (0..100u32).collect::<Vec<_>>());
    }

    #[test]
    fn splits_on_the_longer_axis() {
        // 横長の並び。x方向にだけ広がっているので、x で切られるべき。
        let bboxes: Vec<Bbox> = (0..40).map(|x| point(x as f64, 0.0)).collect();
        let order = pack(&bboxes, 10).unwrap();

        let extents = row_group_extents(&order, &bboxes, 10);
        assert_eq!(extents.len(), 4);
        for extent in extents {
            assert!(extent.width() <= 9.0, "x で切られていない: {extent:?}");
        }
    }

    #[test]
    fn handles_empty_input() {
        assert!(pack(&[], 10).unwrap().is_empty());
    }

    #[test]
    fn rejects_zero_row_group_size() {
        assert!(pack(&grid(), 0).is_err());
    }

    // 面積0の地物や欠損があると並べ替えの基準が壊れるので、黙って通さない。
    #[test]
    fn rejects_non_finite_bbox() {
        let bboxes = vec![point(0.0, 0.0), point(f64::NAN, 1.0)];
        let err = pack(&bboxes, 1).unwrap_err();
        assert!(err.to_string().contains("row 1"));
    }
}
