"use client";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/pramaan/client";
export type User = { id: string; email: string | null; role: string };
export function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    api<{ user: User }>("/api/account/session").then(
      (r) => setUser(r.user),
      () => {},
    );
  }, []);
  return (
    <>
      <header className="topbar">
        <nav aria-label="Main">
          <Link href="/" className="brand">
            Gather<span>Events & tickets</span>
          </Link>
          <div className="navlinks">
            <Link href="/">What's on</Link>
            {!user && <Link href="/signin">Sign in</Link>}
            {user?.role === "member" && <Link href="/tickets">My tickets</Link>}
            {(user?.role === "owner" || user?.role === "door") && (
              <Link href="/door">Door check-in</Link>
            )}
            {user?.role === "owner" && (
              <>
                <Link href="/organiser">Organiser</Link>
                <Link href="/owner">Owner settings</Link>
              </>
            )}
            {user && (
              <button
                type="button"
                className="quiet"
                onClick={async () => {
                  await api("/api/account/signout", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  });
                  location.assign("/");
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </nav>
      </header>
      {children}
      <footer>Good events bring people together.</footer>
    </>
  );
}
