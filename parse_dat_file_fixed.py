    def parse_dat_file(self, filename: str, recursive: bool = True, transform: np.ndarray = np.eye(4)) -> List[Port]:
        """
        [严格模式] 检索 .dat 文本并抽取端口。
        逻辑优先级：
        1. 如果 ldraw_fallback.json 中有定义，直接采用并返回（最高优先级）。
        2. 如果没有 Fallback，则进行启发式识别（仅限极简单的 1L 原件）。
        3. 否则（如 6558 等复杂件）若缺少 Fallback 则强制报错，拒绝猜测位置。
        """
        filename = filename.strip().lower().replace('\\', '/')
        part_name = os.path.basename(filename)
        
        # --- 优先级 1：手工补丁 (ldraw_fallback.json) 为最高准则 ---
        if part_name in self.fallback_data:
            local_ports = []
            for i, mp in enumerate(self.fallback_data[part_name].get("ports", [])):
                pos_ldu    = np.array(mp.get("position", [0.0, 0.0, 0.0]))
                pos_global = (transform @ np.append(pos_ldu, 1.0))[:3]
                rot_local  = np.array(mp.get("rotation", np.eye(3).tolist()))
                rot_global = transform[:3, :3] @ rot_local
                p_type     = mp.get("type", "manual_fallback.dat")
                port = Port.create_from_ldraw(
                    f"fallback_{i}", p_type, pos_global * LDU_TO_SI, rot_global,
                    part_context=part_name
                )
                if port: local_ports.append(port)
            logger.info(f"使用 Fallback 标准答案强制加载零件端口: {part_name}")
            return local_ports

        # --- 优先级 2：尝试自动检测（仅限极简零件） ---
        filepath = self.resolve_path(filename)
        if not filepath:
            if not any(x in filename for x in ['stud', 'rect', 'edge']):
                logger.warning(f"解析警告: 库中未找到 {filename}")
            return []

        local_ports: List[Port] = []
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
        except Exception as e:
            logger.error(f"读取文件失败 {filepath}: {e}")
            return []

        # 100% 确信名单：仅限标准的、1L 的、未手动缩放的连接原件
        TRUSTED_PRIMITIVES = ["pin.dat", "axle.dat", "axlehole.dat", "peghole.dat", "halfpin.dat"]

        for line_num, line in enumerate(lines, 1):
            parts = line.strip().split()
            if not parts or parts[0] != '1' or len(parts) < 15:
                continue
            
            child_file = parts[-1].lower()
            child_basename = os.path.basename(child_file)
            
            try:
                x, y, z = map(float, parts[2:5])
                a, b, c, d, e, f, g, h, i = map(float, parts[5:14])
                local_mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1]])
                global_mat = transform @ local_mat
                
                is_semantic = any(prim in child_file for prim in SEMANTIC_PRIMITIVES)
                is_connector = any(child_basename.startswith(pfx) for pfx in CONNECTOR_PREFIXES)
                
                if (is_semantic or is_connector):
                    # 判断是否有 100% 信心
                    scales_ldu = np.linalg.norm(local_mat[:3, :3], axis=0)
                    # 如果有显著缩放、或者是已知的多单元原件（如 confric6/axlehol8），则视为不稳妥
                    is_scaled = any(abs(s - 1.0) > 0.01 for s in scales_ldu)
                    
                    # 检查是否是多单元语义原件
                    is_multi_unit = False
                    for k in ["confric", "axlehol", "peghol"]:
                        # 如果名字里带数字（通常代表长度，如 confric6），则视为多单元
                        if k in child_basename and any(char.isdigit() for char in child_basename):
                            is_multi_unit = True; break
                    
                    # 最终判定：如果不满足 100% 稳妥条件，直接抛错
                    if is_scaled or is_multi_unit or (child_basename not in TRUSTED_PRIMITIVES):
                        error_msg = (f"\n[STRICT MODE ERROR] 零件 '{part_name}' 含有无法 100% 保证的端口结构 "
                                     f"({child_basename})。\n"
                                     f"操作建议：请在 'ldraw_fallback.json' 中为此零件维护标准端口位置，拒绝自动识别。")
                        logger.error(error_msg)
                        raise ValueError(error_msg)

                    # 只有极简单的 1L 原件才会被加入
                    port = Port.create_from_ldraw(
                        f"port_{len(local_ports)}", child_file,
                        global_mat[:3, 3] * LDU_TO_SI, global_mat[:3, :3],
                        part_context=filename
                    )
                    if port: local_ports.append(port)
                
                elif recursive:
                    # 递归处理非连接语义的子部件
                    local_ports.extend(
                        self.parse_dat_file(child_file, recursive=True, transform=global_mat)
                    )

            except ValueError as ve:
                if "[STRICT MODE ERROR]" in str(ve): raise ve
                continue

        # 按位置去重
        return self._deduplicate_ports(local_ports)
