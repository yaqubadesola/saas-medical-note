"use client"

import { useState, FormEvent } from 'react';
import { useAuth } from '@clerk/nextjs';
import DatePicker from 'react-datepicker';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
    fetchEventSource,
    EventStreamContentType,
} from '@microsoft/fetch-event-source';
import { Protect, PricingTable, UserButton } from '@clerk/nextjs';

/** Non-retriable SSE failure; must be rethrown from onerror so fetch-event-source stops looping. */
class SseFatalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SseFatalError';
    }
}

function ConsultationForm() {
    const { getToken } = useAuth();

    // Form state
    const [patientName, setPatientName] = useState('');
    const [visitDate, setVisitDate] = useState<Date | null>(new Date());
    const [notes, setNotes] = useState('');

    // Streaming state
    const [output, setOutput] = useState('');
    const [loading, setLoading] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setOutput('');
        setLoading(true);

        const jwt = await getToken();
        if (!jwt) {
            setOutput('Authentication required');
            setLoading(false);
            return;
        }

        const controller = new AbortController();
        let buffer = '';

        try {
            await fetchEventSource('/api/consultation', {
                signal: controller.signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
                body: JSON.stringify({
                    patient_name: patientName,
                    date_of_visit: visitDate?.toISOString().slice(0, 10),
                    notes,
                }),
                async onopen(response) {
                    if (response.ok && response.headers.get('content-type')?.includes(EventStreamContentType)) {
                        return;
                    }
                
                    if (response.status === 403) {
                        const data = await response.json().catch(() => null);
                
                        const message =
                            data?.detail?.message ||
                            "You need an active subscription to generate medical notes.";
                
                        throw new SseFatalError(message);
                    }
                
                    if (response.status >= 400 && response.status < 500) {
                        throw new SseFatalError(`HTTP ${response.status}`);
                    }
                
                    if (response.status >= 500) {
                        throw new Error("Server error");
                    }
                },
                onmessage(ev) {
                    buffer += ev.data;
                    setOutput(buffer);
                },
                onclose() {
                    if (!buffer) {
                        setOutput("No response received. Please check your subscription.");
                    }
                    setLoading(false);
                },
                // onerror(err) {
                //     if (err instanceof SseFatalError) {
                //         setOutput((prev) => prev || err.message);
                //         setLoading(false);
                //         controller.abort();
                //         throw err;
                //     }
                //     console.error('SSE error:', err);
                //     controller.abort();
                //     setLoading(false);
                // },
                onerror(err) {
                    console.error("SSE Error:", err);
                
                    setOutput(
                        err instanceof Error
                            ? err.message
                            : "Something went wrong. Please check your subscription."
                    );
                
                    setLoading(false);
                    controller.abort();
                },
            });
        } catch (e) {
            if (e instanceof SseFatalError && !buffer) {
                setOutput(e.message);
            }
            setLoading(false);
        }
    }

    return (
        <div className="container mx-auto px-4 py-12 max-w-3xl">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-8">
                Consultation Notes
            </h1>

            <form onSubmit={handleSubmit} className="space-y-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
                <div className="space-y-2">
                    <label htmlFor="patient" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Patient Name
                    </label>
                    <input
                        id="patient"
                        type="text"
                        required
                        value={patientName}
                        onChange={(e) => setPatientName(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="Enter patient's full name"
                    />
                </div>

                <div className="space-y-2">
                    <label htmlFor="date" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Date of Visit
                    </label>
                    <DatePicker
                        id="date"
                        selected={visitDate}
                        onChange={(d: Date | null) => setVisitDate(d)}
                        dateFormat="yyyy-MM-dd"
                        placeholderText="Select date"
                        required
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                    />
                </div>

                <div className="space-y-2">
                    <label htmlFor="notes" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Consultation Notes
                    </label>
                    <textarea
                        id="notes"
                        required
                        rows={8}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="Enter detailed consultation notes..."
                    />
                </div>

                <button 
                    type="submit" 
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
                >
                    {loading ? 'Generating Summary...' : 'Generate Summary'}
                </button>
            </form>

            {output && (
                <section
                    className="mt-10 rounded-2xl border border-slate-200/90 bg-white shadow-md ring-1 ring-slate-900/5 dark:border-gray-600 dark:bg-gray-800/90 dark:ring-white/10 overflow-hidden"
                    aria-label="Generated clinical summary"
                >
                    <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50 to-teal-50/40 px-6 py-3.5 dark:border-gray-700 dark:from-gray-800 dark:to-teal-950/30">
                        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            Clinical summary
                        </h2>
                    </div>
                    <div className="px-6 py-6 sm:px-8">
                        <div className="markdown-content prose prose-slate max-w-none dark:prose-invert prose-headings:font-semibold prose-headings:text-slate-800 dark:prose-headings:text-slate-100 prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-li:text-slate-700 dark:prose-li:text-slate-300 prose-strong:text-slate-900 dark:prose-strong:text-slate-100">
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                {output}
                            </ReactMarkdown>
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}

export default function Product() {
    return (
        <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
            {/* User Menu in Top Right */}
            <div className="absolute top-4 right-4">
                <UserButton showName={true} />
            </div>

            {/* Subscription Protection */}
            <Protect
                plan="premium_subscription"
                fallback={
                    <div className="container mx-auto px-4 py-12">
                        <header className="text-center mb-12">
                            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
                                Healthcare Professional Plan
                            </h1>
                            <p className="text-gray-600 dark:text-gray-400 text-lg mb-8">
                                Streamline your patient consultations with AI-powered summaries
                            </p>
                        </header>
                        <div className="max-w-4xl mx-auto">
                            <PricingTable />
                        </div>
                    </div>
                }
            >
                <ConsultationForm />
            </Protect>
        </main>
    );
}