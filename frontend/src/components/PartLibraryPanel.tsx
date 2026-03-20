import { useEffect, useState } from 'react';
import axios from 'axios';
import { useStore } from '../store';
import { Search, Box, ChevronRight } from 'lucide-react';

const BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:8000';

interface VerifiedPart {
  part_id: string;
  port_count: number;
  mesh_url: string;
}

export function PartLibraryPanel() {
  const [parts, setParts] = useState<VerifiedPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  const pickFromLibrary = useStore((s) => s.pickFromLibrary);
  const previewPartId = useStore((s) => s.previewPartId);

  useEffect(() => {
    const fetchParts = async () => {
      try {
        const res = await axios.get(`${BACKEND_ORIGIN}/api/get_verified_parts`);
        setParts(res.data);
      } catch (err) {
        console.error('Failed to fetch verified parts:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchParts();
  }, []);

  const filteredParts = parts.filter(p => 
    p.part_id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-white/90 backdrop-blur-md border-r shadow-xl w-72 pointer-events-auto overflow-hidden transition-all">
      <div className="p-4 border-b bg-slate-50">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <Box className="w-5 h-5 text-blue-600" />
          Material Library
        </h2>
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search parts (e.g. 6558)..."
            className="w-full pl-9 pr-4 py-2 text-sm bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-10 gap-2 opacity-50">
             <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
             <span className="text-xs font-medium">Loading catalog...</span>
          </div>
        ) : filteredParts.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            No verified parts found.
          </div>
        ) : (
          filteredParts.map((part) => (
            <button
              key={part.part_id}
              onClick={() => pickFromLibrary(part.part_id)}
              className={`w-full group flex items-center gap-3 p-3 rounded-lg transition-all text-left border ${
                previewPartId === part.part_id 
                  ? 'bg-blue-50 border-blue-200 shadow-sm' 
                  : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-100'
              }`}
            >
              <div className="w-12 h-12 bg-slate-100 rounded border border-slate-200 flex items-center justify-center overflow-hidden">
                 <Box className="w-6 h-6 text-slate-300 transition-colors group-hover:text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-700 truncate">
                  {part.part_id.replace('.dat', '')}
                </div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">
                  {part.port_count} Connection Ports
                </div>
              </div>
              <ChevronRight className={`w-4 h-4 text-slate-300 transition-transform ${
                previewPartId === part.part_id ? 'translate-x-1 text-blue-500' : 'group-hover:translate-x-1'
              }`} />
            </button>
          ))
        )}
      </div>

      <div className="p-3 border-t bg-slate-50 text-[10px] text-slate-400 text-center italic">
        Select a part to preview and pick connection port.
      </div>
    </div>
  );
}
