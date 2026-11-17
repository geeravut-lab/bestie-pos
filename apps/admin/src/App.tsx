import { AuthApp } from '@bestie/auth';

// Public build-time config only (VITE_ prefix). See docs/ENVIRONMENT.md.
export function App() {
  return <AuthApp app="admin" rawEnv={import.meta.env} />;
}
