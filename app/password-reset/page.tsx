"use client";
import { useState } from "react";
import { api } from "../../lib/pramaan/client";
import { Frame } from "../events-ui";
export default function Page() {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Frame title="Reset your password">
      <section className="narrow">
        <p>Recovery needs a confirmed email and the email module switched on.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              const r = await api<{ message: string }>("/api/account/reset-request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: f.get("email") }),
              });
              setMessage(r.message);
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <button type="submit" disabled={busy}>
            Request reset link
          </button>
        </form>
        <p role="status">{message}</p>
      </section>
    </Frame>
  );
}
