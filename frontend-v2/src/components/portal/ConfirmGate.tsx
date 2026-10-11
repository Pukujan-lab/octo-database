import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshCw, ShieldCheck, KeyRound } from "lucide-react";

type Props = {
  code: string | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  value: string;
  onChange: (value: string) => void;
  mfaEnabled: boolean;
  mfaValue: string;
  onMfaChange: (value: string) => void;
};

/** The confirm-code gate: show the freshly minted code, ask a human to type it,
 *  and step up with an authenticator code when MFA is enabled. */
export function ConfirmGate({
  code,
  loading,
  error,
  onRefresh,
  value,
  onChange,
  mfaEnabled,
  mfaValue,
  onMfaChange,
}: Props) {
  const fieldId = useId();
  const mfaId = useId();

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/45 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <span className="eyebrow">Confirmation code</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        This action is gated. Type the code below exactly as issued — it is single-use and expires
        within minutes.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <code className="num rounded border border-primary/45 bg-primary/10 px-2.5 py-1 text-sm font-semibold tracking-[0.3em] text-primary">
          {loading && !code ? "······" : (code ?? "unavailable")}
        </code>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          New code
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={fieldId} className="text-xs font-medium">
          Typed code
        </Label>
        <Input
          id={fieldId}
          data-testid="confirm-code"
          autoComplete="off"
          spellCheck={false}
          placeholder="Type the code by hand"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="num bg-background tracking-[0.2em]"
        />
      </div>

      {error ? <p className="text-xs leading-relaxed text-destructive">Could not fetch a confirmation code: {error}</p> : null}

      {mfaEnabled ? (
        <div className="space-y-1.5">
          <Label htmlFor={mfaId} className="flex items-center gap-1.5 text-xs font-medium">
            <KeyRound className="h-3.5 w-3.5" /> Authenticator or recovery code
          </Label>
          <Input
            id={mfaId}
            data-testid="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            placeholder="123456"
            value={mfaValue}
            onChange={(event) => onMfaChange(event.target.value)}
            className="num bg-background tracking-[0.2em]"
          />
        </div>
      ) : null}
    </div>
  );
}
