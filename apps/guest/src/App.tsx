import { AuthApp } from '@bestie/auth';
import { guestHubPages } from '@bestie/guest-ui';

// Public build-time config only (VITE_ prefix). See docs/ENVIRONMENT.md.
export function App() {
  return <AuthApp app="guest" rawEnv={import.meta.env} guestPages={guestHubPages} />;
}
