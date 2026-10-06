# viewer/

架构图 viewer 的 TypeScript 实现，替代 `vendor/limen/viewer.js`。

纯浏览器脚本：无模块、无依赖、无网络，加载方式和被替代的 JavaScript 一样——
一个 `<script>` 标签，对外发布 `window.PictureViewer`。`tsconfig.json` 里的
`"module": "none"` + `"outFile"` 就是为此，编译产物不带任何模块包装。

```powershell
cd viewer
npm install          # 只装 typescript
npm run build        # -> viewer/viewer.js
npm run check        # 只做类型检查，不产出
```

## 为什么不是手抄一遍

要求是「性能和视觉一点都不变」。手抄 3000 行，任何一处笔误都是行为差异，而且
看不出来。所以正确性由**差分测试**负责，不是由人眼：

```
python tests/equivalence_probe.py
```

同一个 studio 外壳、同一份模型、同一个视口，两次加载，唯一区别是
`vendor/limen/viewer.js` 这个请求由谁应答——上游还是本目录的产物。然后逐元素比对：

- DOM 结构、tag、class、属性
- 叶子文本
- 归一化到宿主原点的 `getBoundingClientRect`（精确到 0.01px）
- 44 个 computed style 属性（排版、盒模型、字体、描边）

当前结果：根层 572 个元素、下钻 `studio.js` 后 1111 个元素，**零差异**。

`tsc --noEmit` 在 `strict` 下 **0 错误**。类型不是装饰：模型边界（`prepare()`）把不可信的 JSON 收成 `VNode` / `VEdge` / `Overlay`，下游才允许直接读字段；剩下的地方由编译器逐条逼出来，每补一批就跑一次上面的差分测试。

阴性对照：把产物里 `GEO.blockH` 从 76 改成 77，同一测试报出 **422 处差异**并定位到
具体元素路径。测试不是摆设。

## 与上游的关系

仍然是 [`overment/limen`](https://github.com/overment/limen) `picture/viewer/` 的演绎作品，
MIT，© Adam Gospodarczyk，许可证见 `vendor/limen/LICENSE`。上游的 `viewer.js` 保留在
`vendor/limen/` 里，作为差分测试的参照物。
