import React from 'react';
import { Html } from '@react-three/drei';
import { useStore } from '../store';
import { InteractionPhase } from '../types';

/**
 * 依附于物理端口的上下文旋转面板
 * 功能：根据当前激活端口的 Profile 决定是否显示旋转控件，允许沿 Z 轴步进旋转零件。
 */
export const ContextualRotationPanel: React.FC = () => {
    const selectedPort = useStore((s) => s.selectedPort);
    const phase = useStore((s) => s.interactionPhase);
    const rotateSelectedPart = useStore((s) => s.rotateSelectedPart);

    // 仅当用户锁定了某一个零件，准备连接（或者已经连接在滑动）时才显示
    if (!selectedPort || (phase !== InteractionPhase.SOURCE_LOCKED && phase !== InteractionPhase.AXIAL_SLIDING)) {
        return null;
    }

    // 简单语义分析：由于前端目前不直接拥有后端的 Profile 语义，我们通过类型字符串猜测。
    // axle (十字轴) 不允许旋转
    const isRigid = selectedPort.portType.includes('axle');
    if (isRigid) {
        return null;
    }

    // 计算 UI 面板的位置：直接渲染在世界坐标上
    const { globalPos } = selectedPort;

    return (
        <Html position={globalPos} center zIndexRange={[100, 0]}>
            <div style={{
                background: 'rgba(30,30,30,0.85)',
                backdropFilter: 'blur(4px)',
                padding: '6px 12px',
                borderRadius: '8px',
                display: 'flex',
                gap: '8px',
                color: 'white',
                fontFamily: 'sans-serif',
                fontSize: '12px',
                border: '1px solid rgba(255,255,255,0.1)',
                pointerEvents: 'auto',
                boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                userSelect: 'none'
            }}>
                <button 
                    onClick={() => rotateSelectedPart(Math.PI / 2)}
                    style={btnStyle}
                    title="顺时针旋转 90°"
                >
                    ↻ 90°
                </button>
                <div style={{ width: '1px', background: 'rgba(255,255,255,0.2)' }} />
                <button 
                    onClick={() => rotateSelectedPart(-Math.PI / 2)}
                    style={btnStyle}
                    title="逆时针旋转 90°"
                >
                    ↺ 90°
                </button>
            </div>
        </Html>
    );
};

const btnStyle = {
    background: 'none',
    border: 'none',
    color: '#4db8ff',
    cursor: 'pointer',
    padding: '4px',
    fontWeight: 'bold',
    outline: 'none'
};
