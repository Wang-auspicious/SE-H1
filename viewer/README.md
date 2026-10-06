# viewer/

架构图 viewer 的 TypeScript 实现。

纯浏览器脚本：无模块、无依赖、无网络。一个 `<script>` 标签，对外发布
`window.PictureViewer`。`tsconfig.json` 里的 `"module": "none"` + `"outFile"`
就是为此，编译产物不带任何模块包装。

```powershell
cd viewer
npm install          # 只装 typescript
npm run build        # -> viewer/viewer.js
npm run check        # 只做类型检查，不产出
```

`tsc --noEmit` 在 `strict` 下 0 错误。模型边界（`prepare()`）把不可信的 JSON 收成 `VNode` / `VEdge` / `Overlay`，下游才允许直接读字段。
