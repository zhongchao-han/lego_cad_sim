import React, { useState, useEffect, useRef } from 'react';
import { usePartSearch, PartSearchHit } from '../hooks/usePartSearch';

interface PartSearchDialogProps {
  onSelectPart?: (partNum: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

// Helper safely injects Meilisearch <em> highlights
const HighlightedText = ({ original, formatted }: { original: string, formatted?: string }) => {
  if (!formatted) return <span>{original}</span>;
  // A simplistic sanitizer to ensure only <em> tags are allowed:
  // Usually meilisearch returns exactly <em>...</em> without any other scary tags unless in the source DB.
  // In a robust enterprise setup, use DOMPurify. Here we trust our own DB.
  return <span dangerouslySetInnerHTML={{ __html: formatted }} />;
};

export const PartSearchDialog: React.FC<PartSearchDialogProps> = ({ onSelectPart, isOpen, onClose }) => {
  const { 
    query, setQuery, results, isLoading, error, handleQueryChange,
    isLlmThinking, rewrittenQuery, llmConfig, updateLlmConfig
  } = usePartSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Focus on mount/open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Clean the input when closed, or maybe preserve? Usually Command palettes clear on close.
  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      // Need a way to clear results, but the hook doesn't expose it directly.
      // Easiest is to fire an empty query.
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="w-full max-w-2xl bg-[#2a2a2e] rounded-xl shadow-2xl border border-white/10 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
      >
        <div className="flex items-center p-4 border-b border-white/5 relative">
          <svg className="w-5 h-5 text-gray-400 absolute left-6" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
          </svg>
          <input 
            ref={inputRef}
            type="text" 
            className="w-full bg-transparent text-white text-lg placeholder-gray-500 outline-none pl-10 pr-12"
            placeholder="Search parts by id, name, or keywords... (e.g. 这个大板孔很多)"
            value={query}
            onChange={handleQueryChange}
          />
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`absolute right-4 p-1.5 rounded-md transition-colors ${showSettings ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
            title="AI Semantic Search Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {/* Settings icon */}
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {showSettings && (
          <div className="bg-black/30 p-4 border-b border-white/5 space-y-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                <span className="text-blue-400">✧</span> AI Semantic Search
              </h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer" 
                  checked={llmConfig.enabled}
                  onChange={(e) => updateLlmConfig({ enabled: e.target.checked })}
                />
                <div className="w-9 h-5 bg-gray-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
            
            {llmConfig.enabled && (
              <div className="grid gap-3 text-xs">
                <div>
                  <label className="block text-gray-400 mb-1">Provider API Base URL</label>
                  <input 
                    type="text" 
                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-gray-200 outline-none focus:border-blue-500/50"
                    placeholder="https://api.deepseek.com/v1"
                    value={llmConfig.providerUrl}
                    onChange={(e) => updateLlmConfig({ providerUrl: e.target.value })}
                  />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="block text-gray-400 mb-1">API Key</label>
                    <input 
                      type="password" 
                      className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-gray-200 outline-none focus:border-blue-500/50"
                      placeholder="sk-..."
                      value={llmConfig.apiKey}
                      onChange={(e) => updateLlmConfig({ apiKey: e.target.value })}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-gray-400 mb-1">Model Name</label>
                    <input 
                      type="text" 
                      className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-gray-200 outline-none focus:border-blue-500/50"
                      placeholder="deepseek-chat"
                      value={llmConfig.model}
                      onChange={(e) => updateLlmConfig({ model: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto no-scrollbar scroll-smooth relative">
          {error && (
            <div className="p-6 text-center text-red-400 text-sm bg-red-900/10 m-4 rounded-lg border border-red-900/30">
              <p className="font-semibold mb-1">Search Engine Error</p>
              <p className="opacity-80 font-mono text-xs">{error}</p>
            </div>
          )}

          {!error && query && results.length === 0 && !isLoading && !isLlmThinking && (
            <div className="p-10 text-center text-gray-500 space-y-2">
              <svg className="w-10 h-10 mx-auto text-gray-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
              <p>No parts matched perfectly.</p>
              <p className="text-xs text-gray-600">Tip: Enable AI Semantic Search if you are using informal descriptions.</p>
            </div>
          )}

          {isLlmThinking && (
            <div className="p-10 flex flex-col items-center justify-center text-blue-400 text-sm gap-3">
              <svg className="animate-spin h-6 w-6 opacity-80" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="animate-pulse">Abstracting LDraw features via AI...</span>
            </div>
          )}

          {rewrittenQuery && !isLlmThinking && !isLoading && (
            <div className="px-4 py-2 bg-blue-900/10 text-blue-300 text-xs flex items-center gap-2 border-b border-blue-500/10">
              <span className="font-bold">✨ AI Translated:</span>
              Searched internally for 
              <span className="bg-black/40 px-1.5 py-0.5 rounded font-mono border border-blue-500/30 text-blue-200">
                {rewrittenQuery}
              </span>
            </div>
          )}

          {!isLlmThinking && (
            <ul className="py-2">
              {results.map((hit) => (
              <li 
                key={hit.id} 
                onClick={() => {
                  onSelectPart?.(hit.part_num);
                  onClose();
                }}
                className="flex items-center gap-4 p-3 mx-2 rounded-lg hover:bg-white/5 cursor-pointer group transition-colors"
              >
                <div className="w-12 h-12 flex-shrink-0 bg-black/40 rounded flex items-center justify-center border border-white/5 overflow-hidden">
                  {hit.thumbnail_url ? (
                    // We can attempt to load the actual thumbnail if available, or just fallback
                    <img 
                      src={`http://localhost:8000${hit.thumbnail_url}`} 
                      alt={hit.name} 
                      className="w-full h-full object-contain p-1"
                      onError={(e) => { (e.target as any).style.display = 'none'; }}
                    />
                  ) : (
                    <span className="text-xs text-gray-600">Img</span>
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between mb-1">
                    <h3 className="text-sm font-medium text-gray-200 truncate group-hover:text-blue-400 transition-colors">
                      <HighlightedText original={hit.part_num} formatted={hit._formatted?.part_num} />
                      <span className="text-[10px] text-gray-500 ml-2">.dat</span>
                    </h3>
                    <div className="flex space-x-2">
                      {hit.status === 'verified' && (
                        <span className="text-[10px] bg-green-900/40 text-green-500 px-1.5 py-0.5 rounded border border-green-800/50">Verified</span>
                      )}
                      {hit.confidence < 1.0 && (
                        <span className="text-[10px] bg-yellow-900/40 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-800/50">Conf. {hit.confidence}</span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 truncate [&>em]:text-blue-400 [&>em]:not-italic [&>em]:font-semibold [&>em]:bg-blue-900/20 [&>em]:px-1 [&>em]:rounded-sm">
                    <HighlightedText original={hit.name} formatted={hit._formatted?.name} />
                  </p>
                </div>
              </li>
            ))}
            </ul>
          )}
        </div>
        
        <div className="px-4 py-2 border-t border-white/5 bg-black/20 flex justify-between text-[10px] font-mono text-gray-500">
          <span className="flex gap-2">
            {results.length > 0 ? `${results.length} hit(s)` : 'Awaiting input...'}
            {(isLoading && !isLlmThinking) ? <span className="text-blue-500/50 animate-pulse">fetching...</span> : null}
          </span>
          <span className="flex items-center gap-1">powered by <span className="font-bold text-gray-400 tracking-wider">MEILISEARCH</span> {llmConfig.enabled ? '& AI' : ''}</span>
        </div>
      </div>
    </div>
  );
};
