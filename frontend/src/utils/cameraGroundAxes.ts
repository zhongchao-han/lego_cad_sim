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
  /** 相机视线方向（世界系，单位向量，相机→场景）。旋转绕「最接近视线的世界轴」用：
   *  让旋转表现为「当前屏幕平面内的顺/逆时针自转」（看哪个面就转哪个面）。 */
  viewDir: [number, number, number];
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

/**
 * 把「屏幕顺时针(cw)/逆时针(ccw)」旋转换算成 {绕哪个世界轴, 带符号角度}，完全跟随当前视角。
 *
 * 跟左右平移吸附到最近世界轴同理：旋转轴取**视线方向上 |分量| 最大的世界轴**，并让它指向
 * 「插入屏幕」方向（与视线同向）——这样在该轴上 +θ（右手定则）在屏幕上即顺时针。于是：
 *   - 俯视平躺件（视线≈-Y）→ 绕世界 Y 自转（平躺件转平）。
 *   - 正对立式转盘/齿轮（视线≈其轴）→ 绕该轴自转（看哪个面就在那个面上顺/逆时针转）。
 * 看哪个面就转哪个面，转镜头后顺/逆时针恒按当前屏幕。无相机时退回俯视（绕世界 -Y=屏幕顺时针）。
 *
 * 纯函数，axes 由调用方注入。
 */
export const screenSpinAxisAngle = (
  screen: 'cw' | 'ccw',
  magnitude: number,
  axes: GroundAxes | null,
): { axis: [number, number, number]; angle: number } => {
  const d = axes ? axes.viewDir : [0, -1, 0]; // 无相机退回俯视
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  // 取 |分量| 最大的世界轴，符号取与视线同向（指向屏幕里）。
  let axis: [number, number, number];
  if (ay >= ax && ay >= az) axis = [0, Math.sign(d[1]) || 1, 0];
  else if (ax >= az)        axis = [Math.sign(d[0]) || 1, 0, 0];
  else                      axis = [0, 0, Math.sign(d[2]) || 1];
  // 绕「指向屏幕里」的轴 +θ = 屏幕顺时针。
  return { axis, angle: (screen === 'cw' ? 1 : -1) * magnitude };
};
