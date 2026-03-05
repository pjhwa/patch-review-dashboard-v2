"use client"
import { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

interface StageJSONViewerProps {
    stageId: string;
    productId?: string;
    stageName: string;
    triggerElement: React.ReactNode;
}

export function StageJSONViewer({ stageId, productId, stageName, triggerElement }: StageJSONViewerProps) {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (open && !data) {
            setLoading(true);
            const query = productId ? `?product=${productId}` : "";
            fetch(`/api/pipeline/stage/${stageId}${query}`)
                .then(res => res.json())
                .then(json => {
                    setData(json);
                    setLoading(false);
                })
                .catch(err => {
                    setData({ error: err.message });
                    setLoading(false);
                });
        }
    }, [open, stageId, productId, data]);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {triggerElement}
            </DialogTrigger>
            <DialogContent className="max-w-[90vw] w-[90vw] bg-[#0a0a0a] border-white/10 text-white">
                <DialogHeader>
                    <DialogTitle className="text-lg md:text-xl font-light pr-6">Raw JSON: {stageName}</DialogTitle>
                    <DialogDescription className="text-white/40">
                        {data?.message || `Debugging view of the raw JSON artifact returned by the underlying script for stage \`${stageId}\`.`}
                    </DialogDescription>
                </DialogHeader>
                <ScrollArea className="h-[70vh] w-full rounded-md border border-white/5 bg-black/50 p-4 font-mono text-sm text-emerald-400">
                    {loading ? (
                        <div className="flex items-center justify-center h-full text-white/50">Loading data...</div>
                    ) : (
                        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(data?.data || data, null, 2)}</pre>
                    )}
                </ScrollArea>
            </DialogContent>
        </Dialog>
    )
}
