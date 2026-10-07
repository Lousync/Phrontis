/** `overlayer.js` 的最小类型面（vendored foliate-js，理由见 view.d.ts 顶部说明）。
 *  静态方法就是**要传给 `draw()` 的绘制函数本身**（`Overlayer.highlight` 等），故必须
 *  import 真实实现而不是只借类型。 */
export class Overlayer {
  add(key: string, range: Range, draw: (rects: DOMRect[], options?: Record<string, unknown>) => void, options?: Record<string, unknown>): void
  remove(key: string): void
  hitTest(point: { x: number; y: number }): [string | null, Range | null]
  static highlight: (rects: DOMRect[], options?: Record<string, unknown>) => void
  static underline: (rects: DOMRect[], options?: Record<string, unknown>) => void
  static squiggly: (rects: DOMRect[], options?: Record<string, unknown>) => void
  static strikethrough: (rects: DOMRect[], options?: Record<string, unknown>) => void
  static outline: (rects: DOMRect[], options?: Record<string, unknown>) => void
}
