import React, { useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { 
    ArrowRight, 
    Check, 
    X, 
    Settings, 
    AlertCircle, 
    CreditCard, 
    Globe, 
    Banknote, 
    Building, 
    ArrowDownCircle,
    PlayCircle,
    ChevronDown,
    Info
} from 'lucide-react';

// --- Constants & Config ---

const CURRENCIES = ['HKD', 'CNH', 'USD', 'EUR', 'GBP', 'AUD', 'JPY', 'OTHER'];
const COUNTRIES = [
    { code: 'HKG', label: 'Hong Kong (HKG)' },
    { code: 'CHN', label: 'China (CHN)' },
    { code: 'USA', label: 'United States (USA)' },
    { code: 'GBR', label: 'United Kingdom (GBR)' },
    { code: 'SGP', label: 'Singapore (SGP)' },
    { code: 'OTHER', label: 'Other' }
];
const METHODS = [
    { value: 'LOCAL', label: 'LOCAL' },
    { value: 'SWIFT', label: 'SWIFT' },
    { value: 'UNSPECIFIED', label: 'Unspecified / Blank' }
];

const DBS_HK_SWIFT = 'DHBKHKHHXXX';

// --- Types ---

interface Inputs {
    method: string;
    country: string;
    currency: string;
    bankSwift: string;
    amount: number;
    pobo: boolean;
}

interface ConditionResult {
    label: string;
    met: boolean;
}

interface StepResult {
    name: string;
    passed: boolean;
    skipped?: boolean;
    reason?: string;
    conditions?: ConditionResult[];
    scenarios?: { label: string; met: boolean }[];
}

interface RouteResult {
    route: string;
    steps: StepResult[];
}

// --- Logic Engine ---

function calculateRoute(inputs: Inputs): RouteResult {
    const { method, country, currency, bankSwift, amount, pobo } = inputs;
    
    // Normalize inputs for logic checks
    const isDbsHk = bankSwift.trim().toUpperCase() === DBS_HK_SWIFT;
    const isHkg = country === 'HKG';
    const isLocal = method === 'LOCAL';
    const isSwift = method === 'SWIFT';
    const isUnspecified = method === 'UNSPECIFIED';
    const validSwift = bankSwift.trim().length > 0;

    const steps: StepResult[] = [];

    // --- Pre-check: Special Handling Group ---
    // Java: method in [LOCAL, SWIFT] OR Blank OR (POBO && ValidSwift && HKG && Cur in [HKD,USD,EUR,CNH])
    
    const isMethodEligible = ['LOCAL', 'SWIFT', 'UNSPECIFIED'].includes(method);
    const isPoboEligible = pobo && validSwift && isHkg && ['HKD', 'USD', 'EUR', 'CNH'].includes(currency);
    const entersGroup1 = isMethodEligible || isPoboEligible;

    const group1Step: StepResult = {
        name: "Channel Eligibility Check",
        passed: entersGroup1,
        conditions: [
            { label: "Method is LOCAL, SWIFT or Unspecified", met: isMethodEligible },
            { label: "OR (POBO is Enabled & Valid Context)", met: isPoboEligible }
        ]
    };
    steps.push(group1Step);

    if (entersGroup1) {
        // --- 1. FPS Check ---
        // Logic: !SWIFT && HKG && !DBS && (HKD || (CNH && amt <= 5M)) && !POBO
        const fpsConditions = [
            { label: "Method is NOT SWIFT", met: !isSwift },
            { label: "Country is HKG", met: isHkg },
            { label: "Bank is NOT DBS HK", met: !isDbsHk },
            { label: "Currency is HKD OR (CNH & Amt ≤ 5M)", met: currency === 'HKD' || (currency === 'CNH' && amount <= 5000000) },
            { label: "POBO is Disabled", met: !pobo }
        ];
        const fpsPassed = fpsConditions.every(c => c.met);
        steps.push({
            name: "FPS",
            passed: fpsPassed,
            conditions: fpsConditions
        });
        if (fpsPassed) return { route: "FPS", steps };

        // --- 2. ACT Check ---
        // Logic: HKG && DBS && !POBO
        const actConditions = [
            { label: "Country is HKG", met: isHkg },
            { label: "Bank IS DBS HK (DHBKHKHHXXX)", met: isDbsHk },
            { label: "POBO is Disabled", met: !pobo }
        ];
        const actPassed = actConditions.every(c => c.met);
        steps.push({
            name: "ACT",
            passed: actPassed,
            conditions: actConditions
        });
        if (actPassed) return { route: "ACT", steps };

        // --- 3. RTGS Check ---
        // Logic: 
        // A: HKG && !DBS && SWIFT && [USD, CNH, HKD, EUR]
        // B: HKG && !DBS && !SWIFT && ([USD, EUR] || (CNH && Amt > 5M))
        // C: POBO && ValidSwift && HKG && [HKD, USD, EUR, CNH]
        
        const s1 = isHkg && !isDbsHk && isSwift && ['USD', 'CNH', 'HKD', 'EUR'].includes(currency);
        const s2 = isHkg && !isDbsHk && !isSwift && (['USD', 'EUR'].includes(currency) || (currency === 'CNH' && amount > 5000000));
        const s3 = pobo && validSwift && isHkg && ['HKD', 'USD', 'EUR', 'CNH'].includes(currency);

        const rtgsPassed = s1 || s2 || s3;
        steps.push({
            name: "RTGS",
            passed: rtgsPassed,
            scenarios: [
                { label: "Scenario A: HKG, !DBS, SWIFT, Cur[USD/CNH/HKD/EUR]", met: s1 },
                { label: "Scenario B: HKG, !DBS, !SWIFT, (Cur[USD/EUR] or CNH > 5M)", met: s2 },
                { label: "Scenario C: POBO Enabled, Valid Swift, HKG, Cur[HKD/USD/EUR/CNH]", met: s3 }
            ]
        });
        if (rtgsPassed) return { route: "RTGS", steps };
    } else {
        // If group 1 failed, we skip to TT
        steps.push({ name: "FPS", passed: false, skipped: true, reason: "Skipped due to Eligibility Check" });
        steps.push({ name: "ACT", passed: false, skipped: true, reason: "Skipped due to Eligibility Check" });
        steps.push({ name: "RTGS", passed: false, skipped: true, reason: "Skipped due to Eligibility Check" });
    }

    // --- 4. TT Check (Fallback) ---
    // Logic: SWIFT || Unspecified || !HKG || (HKG && !DBS && !USD/HKD/CNH) || POBO
    // Note: The logic implies this catches everything else, but we display the reason.
    
    const ttS1 = isSwift;
    const ttS2 = isUnspecified;
    const ttS3 = !isHkg;
    const ttS4 = isHkg && !isDbsHk && !['USD', 'HKD', 'CNH'].includes(currency);
    const ttS5 = pobo;

    const ttPassed = ttS1 || ttS2 || ttS3 || ttS4 || ttS5;
    steps.push({
        name: "TT",
        passed: ttPassed,
        scenarios: [
            { label: "Method is SWIFT", met: ttS1 },
            { label: "Method is Unspecified", met: ttS2 },
            { label: "Country is NOT HKG", met: ttS3 },
            { label: "HKG, !DBS, Currency NOT in [USD, HKD, CNH]", met: ttS4 },
            { label: "POBO is Enabled", met: ttS5 }
        ]
    });

    if (ttPassed) return { route: "TT", steps };

    return { route: "UNKNOWN", steps };
}

// --- Components ---

const ConditionItem = ({ label, met }: { label: string, met: boolean }) => (
    <div className={`flex items-center gap-2 text-sm ${met ? 'text-green-700 font-medium' : 'text-slate-400'}`}>
        {met ? <Check size={14} /> : <X size={14} />}
        <span>{label}</span>
    </div>
);

const StepCard = ({ step, isFinal }: { step: StepResult, isFinal: boolean }) => {
    const isSuccess = step.passed;
    const isSkipped = step.skipped;

    let borderColor = 'border-slate-200';
    let bgColor = 'bg-white';
    let titleColor = 'text-slate-600';

    if (isSuccess) {
        borderColor = 'border-emerald-500';
        bgColor = 'bg-emerald-50';
        titleColor = 'text-emerald-800';
    } else if (isSkipped) {
        bgColor = 'bg-slate-50';
        titleColor = 'text-slate-400';
    }

    return (
        <div className={`relative flex flex-col border-l-4 ${borderColor} ${bgColor} p-4 shadow-sm rounded-r-lg mb-4 transition-all duration-300`}>
            <div className="flex justify-between items-center mb-2">
                <h3 className={`font-bold text-lg ${titleColor}`}>{step.name}</h3>
                {isSuccess && <span className="bg-emerald-200 text-emerald-800 text-xs px-2 py-1 rounded-full font-bold">SELECTED</span>}
                {isSkipped && <span className="bg-slate-200 text-slate-500 text-xs px-2 py-1 rounded-full">SKIPPED</span>}
                {!isSuccess && !isSkipped && <span className="bg-slate-200 text-slate-500 text-xs px-2 py-1 rounded-full">PASSED TO NEXT</span>}
            </div>

            {step.conditions && (
                <div className="space-y-1 ml-1">
                    {step.conditions.map((c, idx) => <ConditionItem key={idx} label={c.label} met={c.met} />)}
                </div>
            )}

            {step.scenarios && (
                <div className="space-y-1 ml-1">
                    <p className="text-xs font-semibold text-slate-500 mb-1">Matches any scenario:</p>
                    {step.scenarios.map((s, idx) => <ConditionItem key={idx} label={s.label} met={s.met} />)}
                </div>
            )}

            {step.reason && <p className="text-sm text-slate-500 italic">{step.reason}</p>}
        </div>
    );
};

const App = () => {
    const [inputs, setInputs] = useState<Inputs>({
        method: 'LOCAL',
        country: 'HKG',
        currency: 'HKD',
        bankSwift: '',
        amount: 1000,
        pobo: false
    });

    const result = useMemo(() => calculateRoute(inputs), [inputs]);

    const handleChange = (field: keyof Inputs, value: any) => {
        setInputs(prev => ({ ...prev, [field]: value }));
    };

    return (
        <div className="min-h-screen bg-slate-100 p-4 md:p-8 font-sans">
            <header className="max-w-6xl mx-auto mb-8 flex items-center gap-3">
                <div className="p-3 bg-blue-600 rounded-lg shadow-lg">
                    <Globe className="text-white" size={24} />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Payment Routing Simulator</h1>
                    <p className="text-slate-500">Visualize payment channel logic (FPS / ACT / RTGS / TT)</p>
                </div>
            </header>

            <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8">
                
                {/* LEFT PANEL: INPUTS */}
                <section className="lg:col-span-4 space-y-6">
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                        <div className="flex items-center gap-2 mb-6 pb-4 border-b border-slate-100">
                            <Settings className="text-blue-600" size={20} />
                            <h2 className="text-lg font-bold text-slate-800">Payment Details</h2>
                        </div>

                        <div className="space-y-5">
                            {/* Method */}
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Payment Method</label>
                                <div className="relative">
                                    <select 
                                        value={inputs.method}
                                        onChange={(e) => handleChange('method', e.target.value)}
                                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-lg appearance-none focus:ring-2 focus:ring-blue-500 outline-none font-medium text-slate-700"
                                    >
                                        {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-3.5 text-slate-400 pointer-events-none" size={16} />
                                </div>
                            </div>

                            {/* Country */}
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Beneficiary Country</label>
                                <div className="relative">
                                    <select 
                                        value={inputs.country}
                                        onChange={(e) => handleChange('country', e.target.value)}
                                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-lg appearance-none focus:ring-2 focus:ring-blue-500 outline-none font-medium text-slate-700"
                                    >
                                        {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-3.5 text-slate-400 pointer-events-none" size={16} />
                                </div>
                            </div>

                            {/* Currency */}
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Currency</label>
                                <div className="grid grid-cols-4 gap-2">
                                    {CURRENCIES.map(curr => (
                                        <button
                                            key={curr}
                                            onClick={() => handleChange('currency', curr)}
                                            className={`py-2 px-1 text-sm font-semibold rounded-md transition-colors ${
                                                inputs.currency === curr 
                                                ? 'bg-blue-600 text-white shadow-md' 
                                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                            }`}
                                        >
                                            {curr}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Bank Swift */}
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Beneficiary Bank SWIFT</label>
                                <div className="relative">
                                    <Building className="absolute left-3 top-3.5 text-slate-400" size={18} />
                                    <input 
                                        type="text"
                                        value={inputs.bankSwift}
                                        onChange={(e) => handleChange('bankSwift', e.target.value)}
                                        placeholder="e.g. DHBKHKHHXXX"
                                        className="w-full pl-10 p-3 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none font-medium text-slate-700 uppercase"
                                    />
                                </div>
                                <div className="mt-2 text-xs text-slate-400 flex items-center gap-1">
                                    <Info size={12} />
                                    <span>Use <strong>{DBS_HK_SWIFT}</strong> for DBS HK logic</span>
                                    <button 
                                        onClick={() => handleChange('bankSwift', DBS_HK_SWIFT)}
                                        className="text-blue-600 hover:underline ml-1 font-medium"
                                    >
                                        Auto-fill
                                    </button>
                                </div>
                            </div>

                            {/* Amount */}
                            <div>
                                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Amount</label>
                                <div className="relative">
                                    <div className="absolute left-3 top-3.5 text-slate-400 font-bold text-sm">{inputs.currency}</div>
                                    <input 
                                        type="number"
                                        value={inputs.amount}
                                        onChange={(e) => handleChange('amount', Number(e.target.value))}
                                        className="w-full pl-12 p-3 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none font-medium text-slate-700"
                                    />
                                </div>
                                <p className="text-xs text-slate-400 mt-2">Threshold for CNH checks: 5,000,000</p>
                            </div>

                            {/* POBO Toggle */}
                            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                                <div>
                                    <span className="block font-bold text-slate-700">POBO Enabled</span>
                                    <span className="text-xs text-slate-500">Payment On Behalf Of</span>
                                </div>
                                <button 
                                    onClick={() => handleChange('pobo', !inputs.pobo)}
                                    className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${inputs.pobo ? 'bg-blue-600' : 'bg-slate-300'}`}
                                >
                                    <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${inputs.pobo ? 'translate-x-6' : ''}`} />
                                </button>
                            </div>

                        </div>
                    </div>
                </section>

                {/* RIGHT PANEL: VISUALIZATION */}
                <section className="lg:col-span-8">
                    
                    {/* Final Result Banner */}
                    <div className="mb-6">
                        <div className={`p-6 rounded-xl shadow-md flex items-center justify-between ${
                            result.route === 'UNKNOWN' ? 'bg-slate-800 text-white' : 'bg-gradient-to-r from-blue-600 to-indigo-700 text-white'
                        }`}>
                            <div>
                                <p className="text-blue-200 text-sm font-semibold uppercase tracking-widest mb-1">Routing Decision</p>
                                <h2 className="text-4xl font-black tracking-tight">{result.route}</h2>
                            </div>
                            <div className="h-16 w-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm">
                                <ArrowRight size={32} className="text-white" />
                            </div>
                        </div>
                    </div>

                    {/* Routing Path Flow */}
                    <div className="relative pl-6 border-l-2 border-dashed border-slate-300 space-y-6">
                        {result.steps.map((step, idx) => (
                            <div key={idx} className="relative">
                                {/* Connector Dot */}
                                <div className={`absolute -left-[31px] top-6 w-4 h-4 rounded-full border-2 ${
                                    step.passed 
                                    ? 'bg-emerald-500 border-emerald-500' 
                                    : (step.skipped ? 'bg-slate-200 border-slate-300' : 'bg-white border-slate-300')
                                }`} />
                                
                                <StepCard step={step} isFinal={step.name === result.route} />
                                
                                {/* Down Arrow if not last */}
                                {idx < result.steps.length - 1 && (
                                    <div className="flex justify-center py-2">
                                        <ArrowDownCircle className="text-slate-300" size={20} />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                </section>
            </main>
        </div>
    );
};

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = createRoot(rootElement);
    root.render(<App />);
}