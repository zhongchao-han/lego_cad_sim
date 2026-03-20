/**
 * cameraUtils.ts
 * ===============
 * 处理摄像机聚焦目标计算的纯逻辑函数，便于测试与复用。
 */

export const LDU = 0.0004;

/**
 * 计算 Library Verify 工作台的摄像机对焦目标
 * @param port 选中的端口数据
 * @returns [x, y, z] 坐标
 */
export const calculateWorkbenchTarget = (port: any): [number, number, number] => {
  if (!port || !port.position) return [0, 0, 0];
  const p = port.position;
  return [p[0] * LDU, p[1] * LDU, p[2] * LDU];
};

/**
 * 计算 Assembly 装配场景的摄像机对焦目标
 * @param selectedPort 选中的全局端口信息
 * @returns [x, y, z] 坐标或 null
 */
export const calculateAssemblyTarget = (selectedPort: any): [number, number, number] | null => {
  if (!selectedPort || !selectedPort.globalPos) return null;
  return selectedPort.globalPos;
};
