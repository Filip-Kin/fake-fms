import type { ReactNode } from "react";

export function Card({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
			{title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>}
			{children}
		</div>
	);
}

type ButtonProps = {
	children: ReactNode;
	onClick?: () => void;
	variant?: "primary" | "danger" | "neutral" | "ghost";
	disabled?: boolean;
	className?: string;
};

export function Button({ children, onClick, variant = "neutral", disabled, className = "" }: ButtonProps) {
	const styles: Record<string, string> = {
		primary: "bg-emerald-600 hover:bg-emerald-500 text-white",
		danger: "bg-red-600 hover:bg-red-500 text-white",
		neutral: "bg-slate-700 hover:bg-slate-600 text-white",
		ghost: "bg-transparent border border-slate-600 hover:bg-slate-800 text-slate-200",
	};
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
		>
			{children}
		</button>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	className = "",
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	className?: string;
}) {
	return (
		<input
			value={value}
			placeholder={placeholder}
			onChange={(e) => onChange(e.target.value)}
			className={`rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none focus:border-emerald-500 ${className}`}
		/>
	);
}

export function NumberInput({
	value,
	onChange,
	className = "",
}: {
	value: number;
	onChange: (v: number) => void;
	className?: string;
}) {
	return (
		<input
			type="number"
			value={value}
			onChange={(e) => onChange(Number(e.target.value))}
			className={`w-20 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none focus:border-emerald-500 ${className}`}
		/>
	);
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
	return (
		<label className="flex cursor-pointer items-center gap-2 text-sm">
			<button
				onClick={() => onChange(!on)}
				className={`h-5 w-9 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-600"}`}
			>
				<span className={`block h-4 w-4 rounded-full bg-white transition ${on ? "translate-x-4" : "translate-x-0.5"}`} />
			</button>
			{label}
		</label>
	);
}
