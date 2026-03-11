'use client';
import { useState, useEffect } from 'react';

export default function PreprocessingPage() {
    const [patches, setPatches] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' | 'info' } | null>(null);

    // Initial load: try to fetch preview if it exists
    useEffect(() => {
        fetchPreview();
    }, []);

    const fetchPreview = async () => {
        setIsLoading(true);
        setMessage(null);
        try {
            const res = await fetch('/api/preprocessing/preview');
            const data = await res.json();
            if (data.success && data.patches) {
                setPatches(data.patches);
                if (data.patches.length > 0) {
                    setMessage({ text: `Loaded ${data.patches.length} patches from preview.`, type: 'success' });
                }
            } else if (data.message) {
                setMessage({ text: data.message, type: 'info' });
            }
        } catch (error) {
            setMessage({ text: 'Failed to load preview data.', type: 'error' });
        } finally {
            setIsLoading(false);
        }
    };

    const runPreprocessingPreview = async () => {
        setIsLoading(true);
        setMessage({ text: 'Running preprocessing script (without saving to DB)...', type: 'info' });
        try {
            const res = await fetch('/api/preprocessing/run', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                await fetchPreview(); // Reload data
            } else {
                setMessage({ text: `Failed: ${data.error}`, type: 'error' });
            }
        } catch (error) {
            setMessage({ text: 'Failed to run preprocessing script.', type: 'error' });
        } finally {
            setIsLoading(false);
        }
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        try {
            const res = await fetch(`/api/preprocessing/search-raw?q=${encodeURIComponent(searchQuery)}`);
            const data = await res.json();
            if (data.success) {
                setSearchResults(data.results);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setIsSearching(false);
        }
    };

    const addMissingPatch = (patch: any) => {
        // Prevent duplicates
        if (!patches.find(p => p.id === patch.id)) {
            setPatches(prev => [patch, ...prev]);
            setMessage({ text: `Added missing patch: ${patch.id}`, type: 'success' });
        }
    };

    const removePatch = (id: string) => {
        setPatches(prev => prev.filter(p => (p.id || p.issueId) !== id));
    };

    const confirmAndStartReview = async () => {
        if (patches.length === 0) {
            setMessage({ text: 'No patches to confirm.', type: 'error' });
            return;
        }

        setIsLoading(true);
        setMessage({ text: 'Saving to database and starting AI review...', type: 'info' });

        try {
            const res = await fetch('/api/preprocessing/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patches })
            });
            const data = await res.json();

            if (data.success) {
                setMessage({ text: data.message, type: 'success' });
                // Optional: Redirect to pipeline page after 2 seconds
                setTimeout(() => {
                    window.location.href = '/pipeline';
                }, 2000);
            } else {
                setMessage({ text: `Failed: ${data.error}`, type: 'error' });
            }
        } catch (error) {
            setMessage({ text: 'Failed to confirm patches.', type: 'error' });
        } finally {
            setIsLoading(false);
        }
    };


    return (
        <div className="p-8 max-w-[1600px] mx-auto space-y-8">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Preprocessing Verification</h1>
                    <p className="text-muted-foreground mt-2">
                        Preview, add missing, and manually verify filtered patches before submitting them to AI Review.
                    </p>
                </div>
                <div className="flex gap-4">
                    <button 
                        onClick={runPreprocessingPreview}
                        disabled={isLoading}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium disabled:opacity-50"
                    >
                        {isLoading ? 'Running...' : 'Run Preprocessing (Preview)'}
                    </button>
                    <button 
                        onClick={confirmAndStartReview}
                        disabled={isLoading || patches.length === 0}
                        className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md font-medium disabled:opacity-50"
                    >
                        Confirm & Start AI Review
                    </button>
                </div>
            </div>

            {message && (
                <div className={`p-4 rounded-md ${
                    message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' :
                    message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' :
                    'bg-blue-50 text-blue-700 border border-blue-200'
                }`}>
                    {message.text}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                {/* Main Patches Table */}
                <div className="md:col-span-3 border rounded-md shadow-sm bg-white overflow-hidden flex flex-col h-[70vh]">
                    <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
                        <h2 className="font-semibold text-gray-700">Selected Patches ({patches.length})</h2>
                    </div>
                    <div className="overflow-y-auto flex-1 p-0">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                            <thead className="bg-gray-50 sticky top-0">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor/Comp</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Summary</th>
                                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {patches.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                                            No patches loaded. Click "Run Preprocessing" to fetch.
                                        </td>
                                    </tr>
                                ) : (
                                    patches.map((p, i) => (
                                        <tr key={p.id || p.issueId || i} className="hover:bg-gray-50">
                                            <td className="px-6 py-4 whitespace-nowrap font-medium text-gray-900">{p.id || p.issueId}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                                                <div className="font-medium text-gray-900">{p.vendor}</div>
                                                <div className="text-xs">{p.component}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-gray-500">{p.date || p.releaseDate}</td>
                                            <td className="px-6 py-4 text-gray-500 max-w-xs truncate" title={p.summary || p.description}>
                                                {p.summary || p.description}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <button 
                                                    onClick={() => removePatch(p.id || p.issueId)}
                                                    className="text-red-600 hover:text-red-900 bg-red-50 hover:bg-red-100 px-2 py-1 rounded"
                                                >
                                                    Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Search / Add Missing Sidebar */}
                <div className="border rounded-md shadow-sm bg-white overflow-hidden flex flex-col h-[70vh]">
                    <div className="p-4 border-b bg-gray-50 shadow-sm z-10">
                        <h2 className="font-semibold text-gray-700 mb-2">Add Missing Patch</h2>
                        <div className="flex gap-2">
                            <input 
                                type="text" 
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                placeholder="Search raw (e.g. RHSA...)"
                                className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button 
                                onClick={handleSearch}
                                disabled={isSearching || !searchQuery.trim()}
                                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-900 text-white rounded-md text-sm disabled:opacity-50 flex-shrink-0"
                            >
                                {isSearching ? '...' : 'Find'}
                            </button>
                        </div>
                    </div>
                    
                    <div className="overflow-y-auto flex-1 p-4 space-y-3 bg-gray-50/50">
                        {searchResults.length === 0 && !isSearching && searchQuery ? (
                             <div className="text-sm text-center text-gray-500 py-4">No results found in raw data.</div>
                        ) : searchResults.map((res: any, idx: number) => {
                            const isAdded = !!patches.find(p => p.id === res.id);
                            return (
                                <div key={idx} className={`p-3 border rounded bg-white shadow-sm text-sm transition-colors ${isAdded ? 'border-green-300' : 'border-gray-200'}`}>
                                    <div className="font-medium text-gray-900 break-all">{res.id}</div>
                                    <div className="text-xs text-gray-500 mt-1">{res.vendor} | {res.component}</div>
                                    <div className="text-[11px] mt-2 line-clamp-2 text-gray-600 leading-snug">{res.summary}</div>
                                    <button 
                                        onClick={() => addMissingPatch(res)}
                                        disabled={isAdded}
                                        className={`w-full mt-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                            isAdded 
                                            ? 'bg-green-100 text-green-800 cursor-not-allowed' 
                                            : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                        }`}
                                    >
                                        {isAdded ? 'Added ✓' : '+ Add to List'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
