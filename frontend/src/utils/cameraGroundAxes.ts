/**
 * cameraGroundAxes.ts
 * ===================
 * 把「当前相机在地面(XZ)平面上的 右/前 方向」暴露给键盘 dispatcher，
 * 让方向键平移跟随视角（旋转操作桌面后，方向键仍按屏幕方向移动零件）。
 *
 * 设计：
 *   - CameraController 在 mount 时注册一个 provider（读 controlsRef.current.camera
 *     的 matrixWorld，投影到地面）。dispatcher 在按键时**惰性**调用，零 per-frame
 *     churn、不触发 React 渲染。
 *   - dispatcher 不直接 import 本模块，而是经 DispatcherDeps 注入 getter，保持
 *     keyboardDispatch 的纯函数 / 可 mock 特性（见 keyboardDispatch.ts 设计约束）。
 */

/** 相机在地面(XZ)平面上的单位方向向量，[x, z] 形式。 */
export type GroundAxes = {
  /** 屏幕「右」对应的地面方向（相机 local +X 投影）。 */
  right: [number, number];
  /** 屏幕「前/进画面深处」对应的地面方向（相机视线方向投影）。 */
  forward: [number, number];
};

let provider: (() => GroundAxes | null) | null = null;

/** CameraController 注册/注销 provider。传 null 注销。 */
export const registerCameraGroundAxesProvider = (
  p: (() => GroundAxes | null) | null,
): void => {
  provider = p;
};

/** 惰性读取当前相机地面方向；无相机时返回 null。 */
export const getCameraGroundAxes = (): GroundAxes | null =>
  provider ? provider() : null;
