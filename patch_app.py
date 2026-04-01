with open("frontend/src/App.jsx", "r") as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if line.strip() == "function App() {":
        insert_idx = i + 1
        break

# Move hooks inside App before the conditional return
lines_to_move = [
    "  const view = useStore((state) => state.view);\n",
    "  const setWsConnected = useStore((state) => state.setWsConnected);\n",
    "  const batchUpdatePartStates = useStore((state) => state.batchUpdatePartStates);\n",
    "  const abortCurrentInteraction = useStore((state) => state.abortCurrentInteraction);\n",
    "  const interactionPhase = useStore((state) => state.interactionPhase);\n",
    "  useEffect(() => {\n",
    "    let ws = null;\n",
    "    let reconnectTimer = null;\n",
    "    let isMounted = true;\n",
    "    const connect = () => {\n",
    "      if (!isMounted) return;\n",
    "      ws = new WebSocket('ws://localhost:8000/ws/physics_stream');\n",
    "      ws.onopen = () => { if (isMounted) setWsConnected(true); };\n",
    "      ws.onmessage = (event) => {\n",
    "        if (!isMounted) return;\n",
    "        try {\n",
    "          const data = JSON.parse(event.data);\n",
    "          if (data.state) batchUpdatePartStates(data.state);\n",
    "        } catch {\n",
    "        }\n",
    "      };\n",
    "      ws.onclose = () => { if (isMounted) { setWsConnected(false); reconnectTimer = setTimeout(connect, 2000); } };\n",
    "    };\n",
    "    connect();\n",
    "    return () => { isMounted = false; clearTimeout(reconnectTimer); if (ws) ws.close(); };\n",
    "  }, [setWsConnected, batchUpdatePartStates]);\n",
    "  useEffect(() => {\n",
    "    const handleKeyDown = (e) => {\n",
    "      if (e.key === 'Escape') {\n",
    "        abortCurrentInteraction();\n",
    "      }\n",
    "    };\n",
    "    window.addEventListener('keydown', handleKeyDown);\n",
    "    return () => window.removeEventListener('keydown', handleKeyDown);\n",
    "  }, [abortCurrentInteraction]);\n"
]

# We should probably just do a sed or search and replace instead of this python script
