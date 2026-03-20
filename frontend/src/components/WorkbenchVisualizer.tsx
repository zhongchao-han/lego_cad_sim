import { useStore } from '../store';
import { Plane, Text } from '@react-three/drei';

export function WorkbenchVisualizer() {
  const workbenchGrid = useStore((s) => s.workbenchGrid);
  
  return (
    <group>
      {/* 区域标题 */}
      <Text
        position={[
          workbenchGrid.slots[0].worldPosition[0] + 0.12,
          0.001,
          workbenchGrid.slots[0].worldPosition[2] - 0.05
        ]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.012}
        color="#3b82f6"
        font="https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hjp-Ek-_EeA.woff"
      >
        WORKBENCH STAGING AREA
      </Text>

      {/* 渲染每一个网格槽位 */}
      {workbenchGrid.slots.map((slot) => (
        <group key={slot.index} position={slot.worldPosition}>
          <Plane args={[0.05, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
            <meshBasicMaterial 
              color={slot.occupiedBy ? "#94a3b8" : "#3b82f6"} 
              transparent 
              opacity={slot.occupiedBy ? 0.05 : 0.15} 
            />
          </Plane>
          
          {/* 装饰性外框 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
             <ringGeometry args={[0.024, 0.025, 4]} />
             <meshBasicMaterial color="#3b82f6" transparent opacity={0.2} />
          </mesh>

          {/* 槽位编号 (调试用) */}
          <Text
            position={[0.02, 0.001, 0.02]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.005}
            color="#94a3b8"
          >
            #{slot.index}
          </Text>
        </group>
      ))}
    </group>
  );
}
