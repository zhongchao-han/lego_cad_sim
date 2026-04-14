import re

def fix():
    with open('d:/Users/hanerlv/Documents/workspace/lego_cad_sim/frontend/src/store.ts', 'r', encoding='utf-8') as f:
        content = f.read()

    # Chunk 1: StoreState Interface
    c1_old = """  canRedo: boolean;
  stagingGrid: StagingGrid;

  /**"""
    c1_new = """  canRedo: boolean;
  stagingGrid: StagingGrid;
  snapPreState: {
    movedPartIds: string[];
    prevPositions: Record<string, { position: Vec3; quaternion: Quat }>;
    addedConnections: Array<{ from: string; to: string }>;
  } | null;

  /**"""
    if c1_old in content:
        content = content.replace(c1_old, c1_new)
        print("Replaced chunk 1")

    # Chunk 2: Initial State
    c2_old = """  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),

  // 全局活跃颜色码"""
    c2_new = """  canUndo: false,
  canRedo: false,
  stagingGrid: new StagingGrid(),
  snapPreState: null,

  // 全局活跃颜色码"""
    if c2_old in content:
        content = content.replace(c2_old, c2_new)
        print("Replaced chunk 2")

    # Chunk 3: reset method
    c3_old = """        interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
        slideOffset: 0,
        cameraTarget: null
      });
  },"""
    c3_new = """        interferenceReport: { isBlocked: false, blockingPartId: null, contactPoints: [], reason: null },
        slideOffset: 0,
        cameraTarget: null,
        snapPreState: null
      });
  },"""
    if c3_old in content:
        content = content.replace(c3_old, c3_new)
        print("Replaced chunk 3")

    # Chunk 4: handlePortClick logic
    c4_old = """      get().addLog(`Target port selected: ${port.partId}. Starting snap animation...`, 'PHYSICS');
      set({ interactionPhase: InteractionPhase.ANIMATING_SNAP });
      const ok = await snapParts(selectedPort, port);"""
    c4_new = """      get().addLog(`Target port selected: ${port.partId}. Starting snap animation...`, 'PHYSICS');
      
      const { connections, parts } = get();
      const srcGroup = getConnectedGroup(connections, selectedPort.partId, port.partId);
      const prevPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
      srcGroup.forEach(pid => {
        const p = parts[pid];
        if (p) prevPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
      });

      set({ 
        interactionPhase: InteractionPhase.ANIMATING_SNAP,
        snapPreState: {
          movedPartIds: srcGroup,
          prevPositions,
          addedConnections: [{ from: selectedPort.partId, to: port.partId }]
        }
      });

      const ok = await snapParts(selectedPort, port);"""
    if c4_old in content:
        content = content.replace(c4_old, c4_new)
        print("Replaced chunk 4")

    # Chunk 5: snapParts history logic remove
    c5_old = """    const cmd = createSnapCommand({ movedPartIds: srcGroup, prevPositions, addedConnections: [{ from: source.partId, to: target.partId }] }, () => {}, (snap) => {
        set(prev => {
            const rp = { ...prev.parts };
            Object.entries(snap.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
            return { parts: rp };
        });
    });
    _history.push(cmd);

    // 先更新本地状态，保证 UI 立即响应（乐观更新）"""
    c5_new = """    // History recording is now handled in commitAxialSliding to allow for proper undo/redo of the sliding action

    // 先更新本地状态，保证 UI 立即响应（乐观更新）"""
    if c5_old in content:
        content = content.replace(c5_old, c5_new)
        print("Replaced chunk 5")

    # Chunk 6: abortCurrentInteraction
    c6_old = """  abortCurrentInteraction: () => {
    get().addLog("Aborting port interaction.");
    set({ 
      interactionPhase: InteractionPhase.IDLE, 
      selectedPort: null, 
      hoveredPort: null,
      slidingTarget: null,
      slideOffset: 0
    });
  },"""
    c6_new = """  abortCurrentInteraction: () => {
    const pre = get().snapPreState;
    if (pre) {
        set(prev => {
            const rp = { ...prev.parts };
            Object.entries(pre.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
            const rc = { ...prev.connections };
            pre.addedConnections.forEach(({ from, to }) => {
                if (rc[from]) {
                    const nextSet = new Set(rc[from]);
                    nextSet.delete(to);
                    if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                }
                if (rc[to]) {
                    const nextSet = new Set(rc[to]);
                    nextSet.delete(from);
                    if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                }
            });
            return { parts: rp, connections: rc };
        });
    }

    get().addLog("Aborting port interaction.");
    set({ 
      interactionPhase: InteractionPhase.IDLE, 
      selectedPort: null, 
      hoveredPort: null,
      slidingTarget: null,
      slideOffset: 0,
      snapPreState: null
    });
  },"""
    if c6_old in content:
        content = content.replace(c6_old, c6_new)
        print("Replaced chunk 6")

    # Chunk 7: commitAxialSliding
    c7_old = """  commitAxialSliding: () => {
    const { canUndo, canRedo } = _history;
    set({ 
      interactionPhase: InteractionPhase.IDLE, 
      selectedPort: null, 
      hoveredPort: null, 
      slidingTarget: null,
      slideOffset: 0,
      canUndo,
      canRedo 
    });
    get().addLog("Axial Sliding committed.", 'ACTION');
  },"""
    c7_new = """  commitAxialSliding: () => {
    const { snapPreState, parts } = get();
    if (snapPreState) {
        const nextPositions: Record<string, { position: Vec3; quaternion: Quat }> = {};
        snapPreState.movedPartIds.forEach(pid => {
            const p = parts[pid];
            if (p) nextPositions[pid] = { position: [...p.position] as Vec3, quaternion: [...p.quaternion] as Quat };
        });

        const cmd = createSnapCommand(
            snapPreState,
            () => { // redo
                set(prev => {
                    const rp = { ...prev.parts };
                    Object.entries(nextPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snapPreState.addedConnections.forEach(({ from, to }) => {
                        if (!rc[from]) rc[from] = new Set();
                        if (!rc[to]) rc[to] = new Set();
                        rc[from].add(to);
                        rc[to].add(from);
                    });
                    return { parts: rp, connections: rc };
                });
            },
            (snap) => { // undo
                set(prev => {
                    const rp = { ...prev.parts };
                    Object.entries(snap.prevPositions).forEach(([id, s]) => { if (rp[id]) rp[id] = { ...rp[id], ...(s as Partial<PartState>) }; });
                    const rc = { ...prev.connections };
                    snap.addedConnections.forEach(({ from, to }) => {
                        if (rc[from]) {
                            const nextSet = new Set(rc[from]);
                            nextSet.delete(to);
                            if (nextSet.size === 0) delete rc[from]; else rc[from] = nextSet;
                        }
                        if (rc[to]) {
                            const nextSet = new Set(rc[to]);
                            nextSet.delete(from);
                            if (nextSet.size === 0) delete rc[to]; else rc[to] = nextSet;
                        }
                    });
                    return { parts: rp, connections: rc };
                });
            }
        );
        _history.push(cmd);
    }

    set({ 
      interactionPhase: InteractionPhase.IDLE, 
      selectedPort: null, 
      hoveredPort: null, 
      slidingTarget: null,
      slideOffset: 0,
      snapPreState: null,
      canUndo: _history.canUndo,
      canRedo: _history.canRedo 
    });
    get().addLog("Axial Sliding committed.", 'ACTION');
  },"""
    if c7_old in content:
        content = content.replace(c7_old, c7_new)
        print("Replaced chunk 7")

    with open('d:/Users/hanerlv/Documents/workspace/lego_cad_sim/frontend/src/store.ts', 'w', encoding='utf-8') as f:
        f.write(content)

fix()
