import { adminPages } from '@bestie/admin-ui';
import { AuthApp } from '@bestie/auth';

// Public build-time config only (VITE_ prefix). See docs/ENVIRONMENT.md.
export function App() {
  return <AuthApp app="pos" rawEnv={import.meta.env} pages={adminPages} />;
}
