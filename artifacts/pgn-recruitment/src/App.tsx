import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import {
  getGetPnmQueryKey,
  getGetMeQueryKey,
  getGetVotingRoundQueryKey,
  getListActivityQueryKey,
  getListNotesQueryKey,
  getListPendingApprovalsQueryKey,
  getListPnmsQueryKey,
  getListUsersQueryKey,
  getListVotingRoundsQueryKey,
  getGetDashboardQueryKey,
  useApproveMember,
  useCastVote,
  useCloseVotingRound,
  useCreateNote,
  useCreatePnm,
  useCreateVotingRound,
  useCreateUser,
  useDeletePnm,
  useGetDashboard,
  useGetMe,
  useGetPnm,
  useGetVotingRound,
  useImportPnms,
  useJoinChapter,
  useListActivity,
  useListNotes,
  useListPendingApprovals,
  useListPnms,
  useListUsers,
  useListVotingRounds,
  useRejectMember,
  useRequestUploadUrl,
  useToggleNotePin,
  useUpdatePnm,
  useUpdateUserRole,
  type Member,
  type Pnm,
  type PipelineStatus,
  type VotingRound,
} from '@workspace/api-client-react';
import { Redirect, Route, Switch, Link, useLocation, useParams, Router as WouterRouter } from 'wouter';
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  layout: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#b3262e',
    colorForeground: '#f6f3ef',
    colorMutedForeground: '#a9a29c',
    colorDanger: '#e0555b',
    colorBackground: '#171717',
    colorInput: '#242424',
    colorInputForeground: '#f6f3ef',
    colorNeutral: '#3b3b3b',
    fontFamily: 'DM Sans, sans-serif',
    borderRadius: '0.65rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#171717] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: '!text-[#f6f3ef]',
    headerSubtitle: '!text-[#a9a29c]',
    socialButtonsBlockButtonText: '!text-[#f6f3ef]',
    formFieldLabel: '!text-[#d7d0c9]',
    footerActionLink: '!text-[#e04a52]',
    footerActionText: '!text-[#a9a29c]',
    dividerText: '!text-[#a9a29c]',
    identityPreviewEditButton: '!text-[#e04a52]',
    formFieldSuccessText: '!text-[#7acb9b]',
    alertText: '!text-[#f6f3ef]',
    logoBox: 'mb-5',
    logoImage: 'rounded-lg',
    socialButtonsBlockButton: '!bg-[#242424] !border-[#3b3b3b]',
    formButtonPrimary: '!bg-[#b3262e] hover:!bg-[#922129]',
    formFieldInput: '!bg-[#242424] !border-[#3b3b3b] !text-[#f6f3ef]',
    footerAction: '!bg-transparent',
    dividerLine: '!bg-[#3b3b3b]',
    alert: '!bg-[#3a2022] !border-[#6c3035]',
    otpCodeFieldInput: '!bg-[#242424] !border-[#3b3b3b] !text-[#f6f3ef]',
    formFieldRow: 'mb-4',
    main: '!bg-transparent',
  },
};

const pipelineLabels: Record<string, string> = {
  new: 'New',
  interviewed: 'Interviewed',
  voting: 'In voting',
  bid_extended: 'Bid extended',
  not_extended: 'Not extended',
  accepted: 'Accepted',
  declined: 'Declined',
};

const navGroups = [
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: '/roster', label: 'Active roster', icon: Users },
      { href: '/voting', label: 'Voting', icon: ClipboardCheck },
      { href: '/archive', label: 'Archive', icon: Archive },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck, admin: true },
      { href: '/members', label: 'Members & roles', icon: UserRound, admin: true },
      { href: '/activity', label: 'Activity log', icon: Activity, admin: true },
    ],
  },
];

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'PG';
}

function PnmPhoto({ photoPath, name, className = 'avatar avatar-lg' }: { photoPath?: string | null; name: string; className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [photoPath]);
  if (!photoPath || imageFailed) return <div className={className}>{initials(name)}</div>;
  return <div className={`${className} photo-frame`}><img src={`${basePath}/api/storage${photoPath}`} alt={`${name} profile`} onError={() => setImageFailed(true)} /></div>;
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  const days = Math.round((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function useToastLite() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return { message, show: setMessage };
}

function Toast({ message }: { message: string }) {
  return message ? <div className="toast-lite" role="status" data-testid="status-toast">{message}</div> : null;
}

function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card card-pad" data-testid="loading-state">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height: index === 0 ? 24 : 16, width: `${78 - index * 9}%`, marginBottom: 15 }} />
      ))}
    </div>
  );
}

function ErrorState({ message = 'This workspace could not load right now.', onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="error-state" data-testid="error-state">
      <strong>Could not load this view.</strong> <span>{message}</span>
      {onRetry ? <button className="btn btn-danger btn-sm" style={{ marginLeft: 12 }} onClick={onRetry} data-testid="button-retry">Try again</button> : null}
    </div>
  );
}

function EmptyState({ title, copy, icon: Icon = FileText }: { title: string; copy: string; icon?: typeof FileText }) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty-icon"><Icon size={19} /></div>
      <div className="empty-title">{title}</div>
      <div className="empty-copy">{copy}</div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const tone = value === 'open' || value === 'active' || value === 'accepted' ? 'status-active' : value === 'pending' || value === 'voting' ? 'status-pending' : 'status-closed';
  return <span className={`status ${tone}`} data-testid={`status-${value}`}>{value === 'open' ? <span style={{ width: 5, height: 5, borderRadius: 99, background: 'currentColor' }} /> : null}{pipelineLabels[value] ?? value}</span>;
}

function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: dark ? 'white' : 'hsl(var(--foreground))' }}>
      <div className="logo-mark">ΦΓΝ</div>
      <div>
        <div style={{ fontWeight: 700, letterSpacing: '-.04em', fontSize: 14 }}>VirginatechPGN</div>
        <div style={{ color: dark ? 'hsl(0 0% 55%)' : 'hsl(var(--muted-foreground))', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', marginTop: 2 }}>Virginia Tech</div>
      </div>
    </div>
  );
}

function Sidebar({ user, open, onClose }: { user?: Member; open: boolean; onClose: () => void }) {
  const [location] = useLocation();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} data-testid="sidebar">
      <div className="sidebar-logo"><Logo dark /></div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {navGroups.map((group) => (
          <div key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.filter((item) => !('admin' in item) || !item.admin || isAdmin).map((item) => {
              const Icon = item.icon;
              const active = location === item.href || (item.href === '/pnms' && location.startsWith('/pnms/'));
              return (
                <Link key={item.href} href={item.href} className={`nav-item ${active ? 'active' : ''}`} onClick={onClose} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}>
                  <Icon size={16} strokeWidth={active ? 2.2 : 1.8} /><span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="user-chip">
          <div className="avatar">{initials(user?.name ?? 'Member')}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name ?? 'Chapter member'}</div>
            <div style={{ color: 'hsl(0 0% 58%)', fontSize: 10, marginTop: 2 }}>{user?.role === 'super_admin' ? 'Super admin' : user?.role ?? 'Member'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: user } = useGetMe();
  const [location] = useLocation();
  const current = navGroups.flatMap((group) => group.items).find((item) => location === item.href);
  return (
    <div className="app-shell">
      <Sidebar user={user} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="main-wrap">
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation" data-testid="button-open-menu"><Menu size={17} /></button>
            <span className="topbar-kicker">{current?.label ?? (location.startsWith('/pnms/') ? 'PNM profile' : 'Chapter operations')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span className="topbar-kicker" style={{ fontFamily: 'var(--app-font-mono)', fontSize: 10 }}>FALL 2026 / VT</span>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: 'hsl(var(--muted))', display: 'grid', placeItems: 'center', color: 'hsl(var(--muted-foreground))' }}><Bell size={15} /></div>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1>{subtitle ? <p className="page-subtitle">{subtitle}</p> : null}</div>
      {action}
    </div>
  );
}

function Landing() {
  return (
    <div style={{ minHeight: '100dvh', background: 'hsl(var(--background))' }}>
      <header style={{ height: 76, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 clamp(20px, 5vw, 72px)', borderBottom: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }}>
        <Logo />
        <div style={{ display: 'flex', gap: 9 }}>
          <Link href="/sign-in" className="btn btn-ghost" data-testid="link-sign-in">Sign in</Link>
          <Link href="/sign-up" className="btn btn-primary" data-testid="link-sign-up">Join VT PGN <ArrowRight size={14} /></Link>
        </div>
      </header>
      <section style={{ maxWidth: 1240, margin: '0 auto', padding: 'clamp(70px, 12vw, 150px) clamp(20px, 5vw, 72px) 100px', display: 'grid', gridTemplateColumns: '1.1fr .9fr', gap: '8vw', alignItems: 'center' }}>
        <div>
          <div className="eyebrow">Private chapter workspace · Blacksburg, VA</div>
          <h1 style={{ fontSize: 'clamp(52px, 8vw, 102px)', letterSpacing: '-.085em', lineHeight: '.93', maxWidth: 700, margin: '20px 0 26px' }}>Make the next <span style={{ color: 'hsl(var(--primary))' }}>right</span> call.</h1>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: 'hsl(var(--muted-foreground))', maxWidth: 470, marginBottom: 32 }}>VirginatechPGN keeps Virginia Tech’s chapter aligned from first conversation to final vote. Context lives here, so decisions can be thoughtful and quick.</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Link href="/sign-up" className="btn btn-primary" data-testid="button-landing-access">Join VT PGN <ArrowRight size={15} /></Link><a href="#principles" className="btn btn-secondary" data-testid="link-learn-more">How it works</a></div>
          <div style={{ display: 'flex', gap: 22, marginTop: 44, color: 'hsl(var(--muted-foreground))', font: '11px var(--app-font-mono)', textTransform: 'uppercase', letterSpacing: '.07em' }}><span>01 / Context</span><span>02 / Consensus</span><span>03 / Commitment</span></div>
        </div>
        <div style={{ position: 'relative' }}>
          <div className="card" style={{ padding: 18, transform: 'rotate(2deg)', boxShadow: '18px 22px 0 hsl(var(--primary)/.08)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 22 }}><span className="eyebrow">Today / Overview</span><span style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--muted-foreground))' }}>09:42 AM</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 22 }}><div style={{ padding: 12, background: 'hsl(var(--muted))', borderRadius: 7 }}><div style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--muted-foreground))' }}>ACTIVE PNMS</div><div style={{ fontSize: 25, fontWeight: 700, marginTop: 7 }}>18</div></div><div style={{ padding: 12, background: 'hsl(var(--accent))', borderRadius: 7 }}><div style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--primary))' }}>TO VOTE</div><div style={{ fontSize: 25, fontWeight: 700, marginTop: 7, color: 'hsl(var(--primary))' }}>04</div></div><div style={{ padding: 12, background: 'hsl(var(--muted))', borderRadius: 7 }}><div style={{ font: '10px var(--app-font-mono)', color: 'hsl(var(--muted-foreground))' }}>OPEN ROUNDS</div><div style={{ fontSize: 25, fontWeight: 700, marginTop: 7 }}>02</div></div></div>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 9 }}>Pipeline pulse</div>
            {['New', 'Interviewed', 'In voting', 'Bid extended'].map((label, index) => <div key={label} style={{ display: 'grid', gridTemplateColumns: '82px 1fr 22px', gap: 8, alignItems: 'center', margin: '10px 0', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}><span>{label}</span><div className="bar"><div className="bar-fill" style={{ width: `${[63, 49, 32, 22][index]}%` }} /></div><span style={{ fontFamily: 'var(--app-font-mono)', textAlign: 'right' }}>{[7, 5, 3, 2][index]}</span></div>)}
          </div>
          <div style={{ position: 'absolute', left: -32, bottom: -27, width: 110, height: 110, background: 'hsl(var(--primary))', opacity: .95, zIndex: -1 }} />
        </div>
      </section>
      <section id="principles" style={{ borderTop: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', padding: '86px clamp(20px, 5vw, 72px)' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto' }}><div className="eyebrow">The chapter standard</div><div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 40, marginTop: 18 }}><h2 style={{ fontSize: 'clamp(28px, 4vw, 45px)', lineHeight: 1, letterSpacing: '-.06em', maxWidth: 310 }}>Clear records. Better conversations.</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 24 }}>{[['01','Keep context close','Thoughtful notes make every handoff warmer and every conversation more informed.'],['02','Vote without noise','Each member gets a focused place to weigh in before the round closes.'],['03','Operate with trust','A private, auditable workspace built for chapter leadership.']].map(([n,t,c]) => <div key={n} style={{ borderTop: '2px solid hsl(var(--primary))', paddingTop: 15 }}><div className="eyebrow">{n}</div><div style={{ fontWeight: 700, margin: '13px 0 8px' }}>{t}</div><div style={{ color: 'hsl(var(--muted-foreground))', fontSize: 13, lineHeight: 1.55 }}>{c}</div></div>)}</div></div></div>
      </section>
      <footer style={{ padding: '26px clamp(20px, 5vw, 72px)', display: 'flex', justifyContent: 'space-between', color: 'hsl(var(--muted-foreground))', fontSize: 11, borderTop: '1px solid hsl(var(--border))' }}><span>Phi Gamma Nu · Virginia Tech</span><span>Members only</span></footer>
    </div>
  );
}

function SignInPage() {
  return (
    <div className="auth-shell">
      <div className="auth-visual">
        <Logo dark />
        <div className="auth-statement"><div className="eyebrow" style={{ color: 'hsl(0 72% 68%)' }}>Phi Gamma Nu · Virginia Tech</div><h1>Good judgment is a team sport.</h1><p>A private place for the chapter to stay close to the people, context, and decisions that shape recruitment.</p></div>
        <div className="auth-footer">PRIVATE CHAPTER OPERATIONS / MEMBERS ONLY</div>
      </div>
      <div className="auth-panel">
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} appearance={clerkAppearance} />
      </div>
    </div>
  );
}

function SignUpPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect to="/join" />;
  return (
    <div className="auth-shell">
      <div className="auth-visual"><Logo dark /><div className="auth-statement"><div className="eyebrow" style={{ color: 'hsl(0 72% 68%)' }}>Step 1 of 2 · Create account</div><h1>Create your account.</h1><p>Use your vt.edu email first. You’ll join the VT PGN chapter with its code in the next step.</p></div><div className="auth-footer">VIRGINIA TECH ACCOUNTS ONLY</div></div>
      <div className="auth-panel">
        <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} appearance={clerkAppearance} />
      </div>
    </div>
  );
}

function JoinChapterPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const joinChapter = useJoinChapter();
  const { data: existingMember } = useGetMe({ query: { enabled: isLoaded && Boolean(isSignedIn), retry: false, queryKey: getGetMeQueryKey() } });
  if (!isLoaded) return <div className="auth-shell" />;
  if (!isSignedIn) return <Redirect to="/sign-up" />;
  if (existingMember) return <Redirect to="/dashboard" />;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    joinChapter.mutate({ data: { code: code.trim() } }, {
      onSuccess: (member) => {
        queryClient.setQueryData(getGetMeQueryKey(), member);
        setLocation('/dashboard');
      },
      onError: () => setError('That chapter code is not valid. Check it and try again.'),
    });
  };
  return (
    <div className="auth-shell">
      <div className="auth-visual"><Logo dark /><div className="auth-statement"><div className="eyebrow" style={{ color: 'hsl(0 72% 68%)' }}>Step 2 of 2 · Join chapter</div><h1>Join VT PGN.</h1><p>Your account is ready. Enter the chapter code to connect it to Phi Gamma Nu at Virginia Tech.</p></div><div className="auth-footer">PRIVATE CHAPTER OPERATIONS / FALL 2026</div></div>
      <div className="auth-panel"><div className="auth-card" style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 14, padding: 26 }}>
        <div className="eyebrow">Join VT PGN</div><h2 style={{ marginTop: 8 }}>Enter the chapter code.</h2><p className="auth-help">This is the final step before your membership request is sent to chapter leadership.</p>
        <form className="auth-form" onSubmit={submit}><div className="field"><label className="field-label" htmlFor="chapter-code">Chapter code</label><input id="chapter-code" className="input" required value={code} onChange={(event) => setCode(event.target.value)} placeholder="PGN-1234" autoComplete="off" data-testid="input-chapter-code" /></div>{error ? <div className="error-state" style={{ padding: 11 }}>{error}</div> : null}<button className="btn btn-primary" type="submit" disabled={joinChapter.isPending}>{joinChapter.isPending ? 'Joining…' : 'Join the chapter'} <ArrowRight size={14} /></button></form>
        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12 }} onClick={() => void signOut({ redirectUrl: `${basePath}/sign-up` })}>Use a different account</button>
      </div></div>
    </div>
  );
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-shell" />;
  return isSignedIn ? <Redirect to="/dashboard" /> : <Landing />;
}

function PendingAccess() {
  const { signOut } = useClerk();
  return <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24 }}><div className="card section-card" style={{ maxWidth: 440, textAlign: 'center' }}><div className="logo-mark" style={{ margin: '0 auto 18px' }}>ΦΓΝ</div><div className="eyebrow">VT PGN member request received</div><h1 className="page-title">You’re in the chapter queue.</h1><p className="page-subtitle">Your account is connected to Virginia Tech PGN. An Admin needs to approve it before you can view recruitment records.</p><button className="btn btn-secondary" style={{ marginTop: 22 }} onClick={() => void signOut({ redirectUrl: basePath || '/' })}>Sign out</button></div></div>;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { data: user, isLoading, isError } = useGetMe({ query: { enabled: isLoaded && Boolean(isSignedIn), retry: false, queryKey: getGetMeQueryKey() } });
  if (!isLoaded || (isSignedIn && isLoading)) return <div className="auth-shell" />;
  if (!isSignedIn) return <Redirect to="/" />;
  if (isError) return <Redirect to="/join" />;
  if (user?.status === 'pending') return <PendingAccess />;
  return <>{children}</>;
}

function Dashboard() {
  const { data, isLoading, isError, refetch } = useGetDashboard();
  if (isLoading) return <><PageHeader eyebrow="Chapter operations" title="Good morning." subtitle="Loading your recruitment overview." /><LoadingBlock /></>;
  if (isError || !data) return <><PageHeader eyebrow="Chapter operations" title="Good morning." /><ErrorState onRetry={() => refetch()} /></>;
  const maxPipeline = Math.max(...data.pipeline.map((item) => item.count), 1);
  return <><PageHeader eyebrow="Chapter operations / Overview" title="Good morning." subtitle="Here’s what needs your attention across the chapter." action={<Link href="/voting" className="btn btn-primary" data-testid="button-dashboard-vote"><ClipboardCheck size={15} /> Review votes <span style={{ background: 'hsl(0 0% 100%/.2)', padding: '2px 5px', borderRadius: 4 }}>{data.outstandingVotes}</span></Link>} /><div className="stat-grid"><div className="card stat-card"><div className="stat-label"><Users size={14} /> Total PNMs</div><div className="stat-number" data-testid="text-total-pnms">{data.totalPnms}</div><div className="stat-meta">all time</div></div><div className="card stat-card"><div className="stat-label"><Sparkles size={14} /> Active roster</div><div className="stat-number" data-testid="text-active-pnms">{data.activePnms}</div><div className="stat-meta">this semester</div></div><div className="card stat-card"><div className="stat-label"><ShieldCheck size={14} /> Pending approvals</div><div className="stat-number" data-testid="text-pending-approvals">{data.pendingApprovals}</div><div className="stat-meta">{data.pendingApprovals ? 'needs review' : 'all caught up'}</div></div><div className="card stat-card"><div className="stat-label"><ClipboardCheck size={14} /> Your votes</div><div className="stat-number" style={{ color: data.outstandingVotes ? 'hsl(var(--primary))' : undefined }} data-testid="text-outstanding-votes">{data.outstandingVotes}</div><div className="stat-meta">outstanding</div></div></div><div className="dashboard-grid"><section className="card section-card"><div className="section-head"><div><div className="section-title">Pipeline pulse</div><div className="page-subtitle" style={{ fontSize: 12, marginTop: 3 }}>Where active PNMs are in the process</div></div><Link href="/roster" className="section-link" data-testid="link-dashboard-roster">View roster <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /></Link></div>{data.pipeline.length ? data.pipeline.map((item) => <div className="pipeline-row" key={item.status}><div className="pipeline-name">{pipelineLabels[item.status] ?? item.status}</div><div className="bar"><div className="bar-fill" style={{ width: `${Math.max(item.count / maxPipeline * 100, item.count ? 8 : 0)}%` }} /></div><div className="pipeline-count">{item.count}</div></div>) : <EmptyState title="No pipeline data yet" copy="Add a PNM to begin tracking recruitment." icon={BarChart3} />}</section><section className="card section-card"><div className="section-head"><div><div className="section-title">Open rounds</div><div className="page-subtitle" style={{ fontSize: 12, marginTop: 3 }}>Active chapter decisions</div></div><Link href="/voting" className="section-link" data-testid="link-dashboard-rounds">All rounds <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /></Link></div>{data.openRounds.length ? data.openRounds.map((round) => <div className="round-item" key={round.id}><div><div className="round-name">{round.name}</div><div className="round-detail">{round.pnmIds.length} PNMs · {round.voteCount} votes cast</div></div><StatusBadge value={round.status} /></div>) : <EmptyState title="No open rounds" copy="Open a round when the chapter is ready to vote." icon={ClipboardCheck} />}</section></div></>;
}

function Roster() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<'name' | 'year' | 'major' | 'status' | 'score'>('name');
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const toast = useToastLite();
  const params = useMemo(() => ({ ...(search ? { search } : {}), ...(status ? { status: status as PipelineStatus } : {}), sort, archived: false }), [search, status, sort]);
  const { data, isLoading, isError, refetch } = useListPnms(params, { query: { queryKey: getListPnmsQueryKey(params) } });
  const create = useCreatePnm();
  const importPnms = useImportPnms();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', major: '', year: 'Freshman', semester: 'Fall 2026' });
  const submit = (event: React.FormEvent) => { event.preventDefault(); create.mutate({ data: form }, { onSuccess: () => { setShowAdd(false); setForm({ firstName: '', lastName: '', email: '', major: '', year: 'Freshman', semester: 'Fall 2026' }); void queryClient.invalidateQueries({ queryKey: getListPnmsQueryKey() }); toast.show('PNM added to the active roster.'); } }); };
  const submitImport = (event: React.FormEvent) => { event.preventDefault(); if (!csv.trim()) return; importPnms.mutate({ data: { csv: csv.trim(), semester: 'Fall 2026' } }, { onSuccess: (result) => { setCsv(''); setShowImport(false); void queryClient.invalidateQueries({ queryKey: getListPnmsQueryKey() }); toast.show(`${result.imported} PNM${result.imported === 1 ? '' : 's'} imported.`); } }); };
  return <><PageHeader eyebrow="Workspace / Roster" title="Active roster" subtitle="The people at the center of this semester’s recruitment." action={<div style={{ display: 'flex', gap: 8 }}><button className="btn btn-secondary" onClick={() => setShowImport((value) => !value)} data-testid="button-import-pnms"><FileText size={14} /> Import CSV</button><button className="btn btn-primary" onClick={() => setShowAdd((value) => !value)} data-testid="button-add-pnm"><Plus size={15} /> Add PNM</button></div>} />{showImport ? <form className="card toolbar" onSubmit={submitImport} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginBottom: 18 }}><div className="field"><label className="field-label" htmlFor="pnm-csv">CSV rows</label><textarea id="pnm-csv" className="textarea" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="firstName,lastName,email,major,year&#10;Jordan,Lee,jordan@vt.edu,Marketing,Junior" data-testid="textarea-pnm-csv" /></div><div style={{ display: 'flex', alignItems: 'end' }}><button className="btn btn-primary" disabled={importPnms.isPending || !csv.trim()} type="submit" data-testid="button-save-import">{importPnms.isPending ? 'Importing…' : 'Import rows'}</button></div></form> : null}{showAdd ? <form className="card toolbar" onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr) auto', gap: 12, marginBottom: 18 }}><div className="field"><label className="field-label" htmlFor="pnm-first">First name</label><input id="pnm-first" className="input" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} data-testid="input-pnm-first-name" /></div><div className="field"><label className="field-label" htmlFor="pnm-last">Last name</label><input id="pnm-last" className="input" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} data-testid="input-pnm-last-name" /></div><div className="field"><label className="field-label" htmlFor="pnm-email">Email</label><input id="pnm-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="input-pnm-email" /></div><div className="field"><label className="field-label" htmlFor="pnm-major">Major</label><input id="pnm-major" className="input" value={form.major} onChange={(e) => setForm({ ...form, major: e.target.value })} data-testid="input-pnm-major" /></div><div className="field"><label className="field-label" htmlFor="pnm-year">Year</label><select id="pnm-year" className="select" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} data-testid="select-pnm-year"><option>Freshman</option><option>Sophomore</option><option>Junior</option><option>Senior</option><option>Graduate</option></select></div><div style={{ display: 'flex', gap: 7, alignItems: 'end' }}><button className="btn btn-primary" disabled={create.isPending} type="submit" data-testid="button-save-pnm">{create.isPending ? 'Saving…' : 'Save PNM'}</button><button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)} data-testid="button-cancel-pnm">Cancel</button></div></form> : null}{create.isError || importPnms.isError ? <ErrorState message="The roster change could not be saved. Check the data and try again." /> : null}<div className="card"><div className="toolbar"><div style={{ position: 'relative', flex: 1, minWidth: 220 }}><Search size={15} style={{ position: 'absolute', left: 11, top: 12, color: 'hsl(var(--muted-foreground))' }} /><input className="input search-input" style={{ paddingLeft: 34 }} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, major, or email" data-testid="input-roster-search" /></div><select className="select filter-select" value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-roster-status"><option value="">All pipeline states</option>{Object.entries(pipelineLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="select filter-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} data-testid="select-roster-sort"><option value="name">Sort: Name</option><option value="year">Sort: Year</option><option value="major">Sort: Major</option><option value="status">Sort: Status</option><option value="score">Sort: Legacy average</option></select><button className="btn btn-secondary btn-sm" onClick={() => { setSearch(''); setStatus(''); }} data-testid="button-clear-filters"><SlidersHorizontal size={14} /> Clear</button></div>{isLoading ? <LoadingBlock /> : isError ? <div style={{ padding: 16 }}><ErrorState onRetry={() => refetch()} /></div> : !data?.length ? <EmptyState title="No PNMs match these filters" copy="Try widening the search or add a new PNM to the roster." icon={Users} /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>PNM</th><th>Year / major</th><th>GPA</th><th>Pipeline</th><th>Legacy avg</th><th>Updated</th><th /></tr></thead><tbody>{data.map((pnm) => <tr key={pnm.id} data-testid={`row-pnm-${pnm.id}`}><td><Link href={`/pnms/${pnm.id}`} style={{ textDecoration: 'none', color: 'inherit' }} data-testid={`link-pnm-${pnm.id}`}><div className="person"><div className="avatar">{initials(`${pnm.firstName} ${pnm.lastName}`)}</div><div><div className="person-name">{pnm.firstName} {pnm.lastName}</div><div className="person-sub">{pnm.email ?? 'No email recorded'}</div></div></div></Link></td><td><div>{pnm.year ?? '—'}</div><div className="person-sub">{pnm.major ?? 'Major not set'}</div></td><td>{pnm.gpa?.toFixed(2) ?? '—'}</td><td><StatusBadge value={pnm.status} /></td><td><span style={{ fontFamily: 'var(--app-font-mono)' }}>{pnm.averageVote?.toFixed(1) ?? '—'}</span><span className="person-sub" style={{ display: 'block' }}>{pnm.voteCount} legacy scores</span></td><td className="person-sub">{formatRelative(pnm.updatedAt)}</td><td><Link href={`/pnms/${pnm.id}`} className="btn btn-ghost btn-sm" data-testid={`button-view-pnm-${pnm.id}`}><ArrowRight size={14} /></Link></td></tr>)}</tbody></table></div>}</div><Toast message={toast.message} /></>;
}

function Profile() {
  const { id } = useParams<{ id: string }>();
  const pnmId = Number(id);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const toast = useToastLite();
  const { data: currentUser } = useGetMe();
  const { data: pnm, isLoading, isError, refetch } = useGetPnm(pnmId, { query: { queryKey: getGetPnmQueryKey(pnmId), enabled: Number.isFinite(pnmId) } });
  const { data: notes, isLoading: notesLoading } = useListNotes(pnmId, { query: { queryKey: getListNotesQueryKey(pnmId), enabled: Number.isFinite(pnmId) } });
  const update = useUpdatePnm();
  const requestPhotoUpload = useRequestUploadUrl();
  const remove = useDeletePnm();
  const createNote = useCreateNote();
  const togglePin = useToggleNotePin();
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [form, setForm] = useState<Partial<Pnm>>({});
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
  useEffect(() => { if (pnm && !editing) setForm({ firstName: pnm.firstName, lastName: pnm.lastName, pronouns: pnm.pronouns, email: pnm.email, year: pnm.year, major: pnm.major, minor: pnm.minor, gpa: pnm.gpa, photoPath: pnm.photoPath, status: pnm.status, semester: pnm.semester }); }, [pnm, editing]);
  if (isLoading) return <><PageHeader eyebrow="Workspace / Profile" title="PNM profile" /><LoadingBlock rows={6} /></>;
  if (isError || !pnm) return <><PageHeader eyebrow="Workspace / Profile" title="PNM profile" /><ErrorState message="This PNM may have been removed or is unavailable." onRetry={() => refetch()} /></>;
  const save = () => update.mutate({ id: pnmId, data: { ...form, firstName: form.firstName || pnm.firstName, lastName: form.lastName || pnm.lastName } }, { onSuccess: () => { setEditing(false); void queryClient.invalidateQueries({ queryKey: getGetPnmQueryKey(pnmId) }); void queryClient.invalidateQueries({ queryKey: getListPnmsQueryKey() }); toast.show('PNM profile updated.'); } });
  const uploadPhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPhotoUploadError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setPhotoUploadError('Choose a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoUploadError('Choose an image no larger than 5 MB.');
      return;
    }
    setPhotoUploading(true);
    try {
      const { uploadURL, objectPath } = await requestPhotoUpload.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const response = await fetch(uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!response.ok) throw new Error('The image could not be uploaded.');
      await update.mutateAsync({
        id: pnmId,
        data: { ...form, firstName: form.firstName || pnm.firstName, lastName: form.lastName || pnm.lastName, photoPath: objectPath },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetPnmQueryKey(pnmId) }),
        queryClient.invalidateQueries({ queryKey: getListPnmsQueryKey() }),
      ]);
      toast.show(pnm.photoPath ? 'PNM photo replaced.' : 'PNM photo added.');
    } catch {
      setPhotoUploadError('The photo could not be saved. Check your connection and try again.');
    } finally {
      setPhotoUploading(false);
    }
  };
  const addNote = (event: React.FormEvent) => { event.preventDefault(); if (!noteText.trim()) return; createNote.mutate({ id: pnmId, data: { content: noteText.trim() } }, { onSuccess: () => { setNoteText(''); void queryClient.invalidateQueries({ queryKey: getListNotesQueryKey(pnmId) }); toast.show('Note added to the record.'); } }); };
  const removePnm = () => { if (!window.confirm(`Remove ${pnm.firstName} ${pnm.lastName} from the workspace?`)) return; remove.mutate({ id: pnmId }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListPnmsQueryKey() }); setLocation('/roster'); toast.show('PNM removed.'); } }); };
  return <><PageHeader eyebrow="Workspace / PNM profile" title={`${pnm.firstName} ${pnm.lastName}`} subtitle={`Added ${formatDate(pnm.createdAt)} · Last updated ${formatRelative(pnm.updatedAt)}`} action={<Link href="/roster" className="btn btn-secondary" data-testid="button-back-roster"><ArrowLeft size={14} /> Back to roster</Link>} /><div className="card profile-banner"><div className="profile-info"><PnmPhoto photoPath={pnm.photoPath} name={`${pnm.firstName} ${pnm.lastName}`} /><div><div className="profile-name">{pnm.firstName} {pnm.lastName}</div><div className="profile-meta">{pnm.pronouns ?? 'Pronouns not recorded'} · {pnm.email ?? 'No email recorded'}</div><div style={{ marginTop: 10 }}><StatusBadge value={pnm.status} /></div></div></div>{isAdmin ? <div className="photo-control"><label className="btn btn-secondary btn-sm" htmlFor="pnm-photo-upload"><Upload size={13} />{photoUploading ? 'Uploading…' : pnm.photoPath ? 'Replace photo' : 'Add photo'}</label><input id="pnm-photo-upload" type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={uploadPhoto} disabled={photoUploading} data-testid="input-pnm-photo" /><div className="photo-hint">JPG, PNG, or WebP · 5 MB max</div>{photoUploadError ? <div className="photo-error" role="alert">{photoUploadError}</div> : null}</div> : null}<div className="row-actions">{editing && isAdmin ? <><button className="btn btn-primary" onClick={save} disabled={update.isPending} data-testid="button-save-profile">{update.isPending ? 'Saving…' : 'Save changes'}</button><button className="btn btn-ghost" onClick={() => setEditing(false)} data-testid="button-cancel-profile">Cancel</button></> : !editing && isAdmin ? <><button className="btn btn-secondary" onClick={() => setEditing(true)} data-testid="button-edit-profile"><FileText size={14} /> Edit details</button><button className="btn btn-danger" onClick={removePnm} disabled={remove.isPending} data-testid="button-delete-pnm"><Archive size={14} /> Remove</button></> : null}</div></div><div className="profile-grid" style={{ marginTop: 16 }}><div className="card section-card"><div className="section-head"><div className="section-title">Candidate details</div>{editing && isAdmin ? <span className="eyebrow">Editing</span> : null}</div>{editing && isAdmin ? <div className="detail-grid">{[['firstName','First name'],['lastName','Last name'],['email','Email'],['pronouns','Pronouns'],['year','Year'],['major','Major'],['minor','Minor'],['gpa','GPA'],['semester','Semester']].map(([key, label]) => <div className="field" key={key}><label className="field-label" htmlFor={`edit-${key}`}>{label}</label><input id={`edit-${key}`} className="input" value={String(form[key as keyof typeof form] ?? '')} onChange={(e) => setForm({ ...form, [key]: key === 'gpa' ? (e.target.value ? Number(e.target.value) : null) : e.target.value })} data-testid={`input-edit-${key}`} /></div>)}<div className="field"><label className="field-label" htmlFor="edit-status">Pipeline state</label><select id="edit-status" className="select" value={String(form.status ?? pnm.status)} onChange={(e) => setForm({ ...form, status: e.target.value as PipelineStatus })} data-testid="select-edit-status">{Object.entries(pipelineLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div> : <div className="detail-grid">{[['Year', pnm.year],['Major', pnm.major],['Minor', pnm.minor],['GPA', pnm.gpa?.toFixed(2)],['Semester', pnm.semester],['Email', pnm.email]].map(([label, value]) => <div key={label}><div className="field-label">{label}</div><div className="detail-value">{value || 'Not recorded'}</div></div>)}</div>}<div style={{ borderTop: '1px solid hsl(var(--border))', marginTop: 23, paddingTop: 17 }}><div className="field-label">Legacy voting history</div><div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}><span style={{ font: '500 25px var(--app-font-mono)', color: 'hsl(var(--primary))' }}>{pnm.averageVote?.toFixed(1) ?? '—'}</span><span className="page-subtitle">1–5 average from {pnm.voteCount} historical scores · current Yes/No rounds are shown in Voting</span></div></div></div><div className="card section-card"><div className="section-head"><div><div className="section-title">Chapter context</div><div className="page-subtitle" style={{ fontSize: 12, marginTop: 3 }}>Notes are visible to active members</div></div><Pin size={15} color="hsl(var(--primary))" /></div><form onSubmit={addNote} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}><textarea className="textarea" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Record something useful for the next conversation…" style={{ minHeight: 68 }} data-testid="textarea-new-note" /><button className="btn btn-primary" type="submit" disabled={createNote.isPending || !noteText.trim()} data-testid="button-add-note"><Plus size={14} /></button></form>{notesLoading ? <LoadingBlock rows={3} /> : notes?.length ? notes.map((note) => <div className="note" key={note.id} data-testid={`note-${note.id}`}><div className="note-top"><div><span className="note-author">{note.authorName}</span>{note.pinned ? <span className="status status-pending" style={{ marginLeft: 7 }}><Pin size={10} /> Pinned</span> : null}</div><div style={{ display: 'flex', gap: 9, alignItems: 'center' }}><span className="note-date">{formatRelative(note.createdAt)}</span><button className="btn btn-ghost btn-sm" onClick={() => togglePin.mutate({ id: note.id, data: { pinned: !note.pinned } }, { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListNotesQueryKey(pnmId) }) })} data-testid={`button-pin-note-${note.id}`}><Pin size={13} /></button></div></div><div className="note-copy">{note.content}</div></div>) : <EmptyState title="No notes yet" copy="Be the first member to add useful context." icon={BookOpen} />}</div></div><Toast message={toast.message} /></>;
}

function VotingPage() {
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const { data: rounds, isLoading, isError, refetch } = useListVotingRounds();
  const [selected, setSelected] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<string, 'yes' | 'no'>>({});
  const [voteError, setVoteError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', deadline: '' });
  const [selectedPnms, setSelectedPnms] = useState<number[]>([]);
  const { data: pnms } = useListPnms({ archived: false, sort: 'name' });
  const createRound = useCreateVotingRound();
  const closeRound = useCloseVotingRound();
  const castVote = useCastVote();
  const toast = useToastLite();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const openRounds = rounds?.filter((round) => round.status === 'open') ?? [];
  const closedRounds = rounds?.filter((round) => round.status === 'closed') ?? [];
  const activeRound = rounds?.find((round) => round.id === selected) ?? openRounds[0];
  const { data: detail } = useGetVotingRound(activeRound?.id ?? 0, { query: { queryKey: getGetVotingRoundQueryKey(activeRound?.id ?? 0), enabled: Boolean(activeRound?.id) } });
  useEffect(() => {
    if (!activeRound || activeRound.votingMode !== 'binary' || !detail) return;
    setChoices((current) => {
      const next = { ...current };
      detail.results?.forEach((result) => {
        const key = `${activeRound.id}-${result.pnmId}`;
        if (result.myChoice) next[key] = result.myChoice;
        else delete next[key];
      });
      return next;
    });
  }, [activeRound?.id, activeRound?.votingMode, detail]);
  const submitRound = (event: React.FormEvent) => { event.preventDefault(); if (!selectedPnms.length) return; createRound.mutate({ data: { name: form.name, pnmIds: selectedPnms, deadline: form.deadline || null } }, { onSuccess: () => { setShowCreate(false); setForm({ name: '', deadline: '' }); setSelectedPnms([]); void queryClient.invalidateQueries({ queryKey: getListVotingRoundsQueryKey() }); toast.show('Voting round opened.'); } }); };
  const vote = (pnmId: number, choice: 'yes' | 'no') => {
    if (!activeRound || activeRound.votingMode !== 'binary') return;
    const key = `${activeRound.id}-${pnmId}`;
    const previous = choices[key];
    setVoteError('');
    setChoices((current) => ({ ...current, [key]: choice }));
    castVote.mutate({ id: activeRound.id, data: { pnmId, choice } }, {
      onSuccess: () => {
        toast.show('Vote saved.');
        void queryClient.invalidateQueries({ queryKey: getListVotingRoundsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetVotingRoundQueryKey(activeRound.id) });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      },
      onError: () => {
        setChoices((current) => {
          const next = { ...current };
          if (previous) next[key] = previous;
          else delete next[key];
          return next;
        });
        setVoteError('Your vote could not be saved. Check your connection and try again.');
      },
    });
  };
  const renderResults = (round: VotingRound) => {
    if (!detail || activeRound?.id !== round.id) return null;
    return <div style={{ borderTop: '1px solid hsl(var(--border))', marginTop: 4 }}>
      {round.votingMode === 'numeric' ? <div className="page-subtitle" style={{ padding: '14px 0 2px' }}>Legacy 1–5 scores are preserved for historical reference and are not combined with Yes/No percentages.</div> : null}
      {round.pnmIds.map((pnmId) => {
        const pnm = pnms?.find((item) => item.id === pnmId);
        const result = detail.results?.find((item) => item.pnmId === pnmId);
        const key = `${round.id}-${pnmId}`;
        const selectedChoice = choices[key] ?? result?.myChoice ?? undefined;
        const electorate = result?.electorateCount ?? round.electorateCount ?? 0;
        return <div className="pnm-vote-row" key={pnmId} data-testid={`row-vote-${pnmId}`}>
          <div className="person"><div className="avatar">{initials(pnm ? `${pnm.firstName} ${pnm.lastName}` : 'PNM')}</div><div><div className="person-name">{pnm ? `${pnm.firstName} ${pnm.lastName}` : result?.pnmName ?? `PNM #${pnmId}`}</div><div className="person-sub">{pnm?.major ?? 'Candidate context'}</div></div></div>
          {round.votingMode === 'numeric' ? <div style={{ textAlign: 'right' }}><div className="score">{result?.average?.toFixed(1) ?? '—'}</div><div className="person-sub">{result?.voteCount ?? 0} historical scores</div></div> : <div style={{ minWidth: 225, textAlign: 'right' }}>
            <div className="person-sub" style={{ marginBottom: 8 }}>Yes {result?.yesCount ?? 0} ({(result?.yesPercentage ?? 0).toFixed(1)}%) · No {result?.noCount ?? 0} ({(result?.noPercentage ?? 0).toFixed(1)}%)</div>
            <div className="person-sub" style={{ marginBottom: 8 }}>Not voted {result?.notVotedCount ?? Math.max(electorate - (result?.voteCount ?? 0), 0)} ({(result?.notVotedPercentage ?? 0).toFixed(1)}%) · {electorate} active brothers</div>
            <div className="vote-scale"><button className={`vote-btn ${selectedChoice === 'yes' ? 'selected' : ''}`} onClick={() => vote(pnmId, 'yes')} disabled={castVote.isPending || round.status !== 'open'} data-testid={`button-vote-${pnmId}-yes`}>Yes</button><button className={`vote-btn ${selectedChoice === 'no' ? 'selected' : ''}`} onClick={() => vote(pnmId, 'no')} disabled={castVote.isPending || round.status !== 'open'} data-testid={`button-vote-${pnmId}-no`}>No</button></div>
          </div>}
        </div>;
      })}
    </div>;
  };
  return <><PageHeader eyebrow="Workspace / Voting" title="Voting rounds" subtitle="Every active brother gets one Yes or No vote. Percentages use the full active chapter electorate." action={isAdmin ? <button className="btn btn-primary" onClick={() => setShowCreate((value) => !value)} data-testid="button-create-round"><Plus size={15} /> Open round</button> : null} />{showCreate ? <form className="card toolbar" onSubmit={submitRound} style={{ display: 'grid', gridTemplateColumns: '1fr 180px 1.6fr auto', gap: 12, marginBottom: 18 }}><div className="field"><label className="field-label" htmlFor="round-name">Round name</label><input id="round-name" required className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Second round conversations" data-testid="input-round-name" /></div><div className="field"><label className="field-label" htmlFor="round-deadline">Deadline</label><input id="round-deadline" className="input" type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} data-testid="input-round-deadline" /></div><div className="field"><label className="field-label">Include PNMs</label><select className="select" multiple value={selectedPnms.map(String)} onChange={(e) => setSelectedPnms(Array.from(e.target.selectedOptions).map((option) => Number(option.value)))} style={{ height: 38 }} data-testid="select-round-pnms">{pnms?.map((pnm) => <option key={pnm.id} value={pnm.id}>{pnm.firstName} {pnm.lastName}</option>)}</select></div><button className="btn btn-primary" type="submit" disabled={createRound.isPending || !selectedPnms.length} data-testid="button-save-round">Open</button></form> : null}{voteError ? <ErrorState message={voteError} /> : null}<div className="card round-card"><div className="section-head"><div><div className="section-title">Open now <span style={{ color: 'hsl(var(--primary))', fontFamily: 'var(--app-font-mono)' }}>{openRounds.length}</span></div><div className="page-subtitle" style={{ fontSize: 12, marginTop: 3 }}>Yes / No choices are private to you until the round closes.</div></div></div>{isLoading ? <LoadingBlock rows={4} /> : isError ? <ErrorState onRetry={() => refetch()} /> : !openRounds.length ? <EmptyState title="No open voting rounds" copy="When a round opens, your PNMs will appear here." icon={ClipboardCheck} /> : openRounds.map((round) => <div key={round.id} onClick={() => setSelected(round.id)} style={{ cursor: 'pointer' }}><div className="round-card-head"><div><div className="round-name">{round.name}</div><div className="round-detail">{round.pnmIds.length} PNMs · {round.voteCount} votes cast{round.electorateCount ? ` · ${round.electorateCount} active brothers` : ''}{round.deadline ? ` · closes ${formatDate(round.deadline)}` : ''}</div></div><div className="row-actions"><StatusBadge value={round.status} />{isAdmin ? <button className="btn btn-secondary btn-sm" onClick={(event) => { event.stopPropagation(); closeRound.mutate({ id: round.id }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListVotingRoundsQueryKey() }); void queryClient.invalidateQueries({ queryKey: getGetVotingRoundQueryKey(round.id) }); toast.show('Voting round closed.'); } }); }} data-testid={`button-close-round-${round.id}`}>Close round</button> : null}</div></div>{renderResults(round)}</div>)}</div><div className="card round-card"><div className="section-head"><div><div className="section-title">Closed history</div><div className="page-subtitle" style={{ fontSize: 12, marginTop: 3 }}>Past decisions stay available for reference.</div></div></div>{closedRounds.length ? closedRounds.map((round) => <div className="round-item" key={round.id} onClick={() => setSelected(round.id)} style={{ cursor: 'pointer' }}><div><div className="round-name">{round.name}</div><div className="round-detail">{round.pnmIds.length} PNMs · {round.votingMode === 'binary' ? `${round.voteCount} Yes/No votes · ${round.electorateCount ?? 0} active brothers` : `${round.voteCount} legacy 1–5 scores`} · closed {formatDate(round.closedAt)}</div>{renderResults(round)}</div><StatusBadge value={round.status} /></div>) : <EmptyState title="No closed rounds" copy="Closed rounds will appear here after decisions are final." icon={Archive} />}</div><Toast message={toast.message} /></>;
}

function VotingRoute() {
  return <ProtectedRoute><AppShell><VotingPage /></AppShell></ProtectedRoute>;
}

function ArchivePage() {
  const { data, isLoading, isError, refetch } = useListPnms({ archived: true, sort: 'name' });
  return <><PageHeader eyebrow="Workspace / Archive" title="Recruitment archive" subtitle="Read-only historical PNMs and chapter outcomes." /><div className="card">{isLoading ? <LoadingBlock /> : isError ? <div style={{ padding: 16 }}><ErrorState onRetry={() => refetch()} /></div> : !data?.length ? <EmptyState title="The archive is quiet" copy="Historical PNMs will appear here once a record is archived." icon={Archive} /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>PNM</th><th>Semester</th><th>Outcome</th><th>Average vote</th><th>Archived</th></tr></thead><tbody>{data.map((pnm) => <tr key={pnm.id} data-testid={`row-archive-${pnm.id}`}><td><Link href={`/pnms/${pnm.id}`} style={{ textDecoration: 'none', color: 'inherit' }}><div className="person"><div className="avatar">{initials(`${pnm.firstName} ${pnm.lastName}`)}</div><div><div className="person-name">{pnm.firstName} {pnm.lastName}</div><div className="person-sub">{pnm.major ?? 'Major not recorded'}</div></div></div></Link></td><td>{pnm.semester ?? '—'}</td><td><StatusBadge value={pnm.status} /></td><td style={{ fontFamily: 'var(--app-font-mono)' }}>{pnm.averageVote?.toFixed(1) ?? '—'}</td><td className="person-sub">{formatDate(pnm.updatedAt)}</td></tr>)}</tbody></table></div>}</div></>;
}

function Approvals() {
  const queryClient = useQueryClient();
  const toast = useToastLite();
  const { data, isLoading, isError, refetch } = useListPendingApprovals();
  const approve = useApproveMember();
  const reject = useRejectMember();
  const act = (id: number, kind: 'approve' | 'reject') => { const mutation = kind === 'approve' ? approve : reject; mutation.mutate({ id }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListPendingApprovalsQueryKey() }); toast.show(kind === 'approve' ? 'Member approved.' : 'Request declined.'); } }); };
  return <><PageHeader eyebrow="Administration / Approvals" title="Member approvals" subtitle="Keep access intentional. Review chapter requests here." /><div className="card section-card">{isLoading ? <LoadingBlock rows={5} /> : isError ? <ErrorState onRetry={() => refetch()} /> : !data?.length ? <EmptyState title="No pending approvals" copy="The member queue is clear." icon={ShieldCheck} /> : data.map((member) => <div className="approval-row" key={member.id} data-testid={`row-approval-${member.id}`}><div className="person"><div className="avatar">{initials(member.name)}</div><div><div className="person-name">{member.name}</div><div className="person-sub">{member.email} · Requested {formatRelative(member.requestedAt)}</div>{member.inviteLabel ? <div className="person-sub">Invite: {member.inviteLabel}</div> : null}</div></div><div className="row-actions"><button className="btn btn-secondary btn-sm" onClick={() => act(member.id, 'reject')} disabled={reject.isPending} data-testid={`button-reject-${member.id}`}><X size={13} /> Decline</button><button className="btn btn-primary btn-sm" onClick={() => act(member.id, 'approve')} disabled={approve.isPending} data-testid={`button-approve-${member.id}`}><Check size={13} /> Approve</button></div></div>)}</div><Toast message={toast.message} /></>;
}

function Members() {
  const queryClient = useQueryClient();
  const toast = useToastLite();
  const { data, isLoading, isError, refetch } = useListUsers();
  const createUser = useCreateUser();
  const updateRole = useUpdateUserRole();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', email: '' });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    createUser.mutate({ data: form }, {
      onSuccess: () => {
        setForm({ name: '', email: '' });
        setShowAdd(false);
        void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.show('Member added and pre-approved.');
      },
    });
  };
  return <><PageHeader eyebrow="Administration / People" title="Members & roles" subtitle="The chapter members who can access this workspace." action={<button className="btn btn-primary" onClick={() => setShowAdd((value) => !value)} data-testid="button-add-member"><Plus size={15} /> Add member</button>} />{showAdd ? <form className="card toolbar" onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, marginBottom: 18 }}><div className="field"><label className="field-label" htmlFor="member-name">Name</label><input id="member-name" className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Alex Johnson" data-testid="input-member-name" /></div><div className="field"><label className="field-label" htmlFor="member-email">VT email</label><input id="member-email" className="input" required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="alex@vt.edu" data-testid="input-member-email" /></div><div style={{ display: 'flex', gap: 7, alignItems: 'end' }}><button className="btn btn-primary" type="submit" disabled={createUser.isPending}>{createUser.isPending ? 'Adding…' : 'Add member'}</button><button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button></div></form> : null}{createUser.isError ? <ErrorState message="That member could not be added. Check the email and try again." /> : null}<div className="card section-card">{isLoading ? <LoadingBlock rows={6} /> : isError ? <ErrorState onRetry={() => refetch()} /> : !data?.length ? <EmptyState title="No members found" copy="Approved chapter members will appear here." icon={Users} /> : data.map((member) => <div className="member-row" key={member.id} data-testid={`row-member-${member.id}`}><div className="person"><div className="avatar">{initials(member.name)}</div><div><div className="person-name">{member.name}</div><div className="person-sub">{member.email} · Joined {formatDate(member.createdAt)}</div></div></div><div className="row-actions"><StatusBadge value={member.status} /><select className="select" style={{ width: 130, height: 32 }} value={member.role === 'super_admin' ? 'admin' : member.role} disabled={member.role === 'super_admin' || updateRole.isPending} onChange={(e) => updateRole.mutate({ id: member.id, data: { role: e.target.value as 'admin' | 'member' } }, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() }); toast.show('Member role updated.'); } })} data-testid={`select-role-${member.id}`}><option value="member">Member</option><option value="admin">Admin</option></select></div></div>)}</div><Toast message={toast.message} /></>;
}

function ActivityPage() {
  const { data, isLoading, isError, refetch } = useListActivity({ limit: 100 }, { query: { queryKey: getListActivityQueryKey({ limit: 100 }) } });
  return <><PageHeader eyebrow="Administration / Audit" title="Activity log" subtitle="A running record of important chapter workspace actions." /><div className="card section-card">{isLoading ? <LoadingBlock rows={7} /> : isError ? <ErrorState onRetry={() => refetch()} /> : !data?.length ? <EmptyState title="No activity yet" copy="Workspace actions will be recorded here." icon={Activity} /> : data.map((item) => <div className="activity-row" key={item.id} data-testid={`row-activity-${item.id}`}><div className="activity-dot" /><div className="activity-copy"><div className="activity-action"><span>{item.actorName}</span> {item.action} <span className="activity-target">{item.target}</span></div><div className="activity-time">{formatDate(item.createdAt)} · {formatRelative(item.createdAt)}</div></div><MoreHorizontal size={16} color="hsl(var(--muted-foreground))" /></div>)}</div></>;
}

function NotFound() {
  return <div style={{ minHeight: '70vh', display: 'grid', placeItems: 'center', textAlign: 'center' }}><div><div className="eyebrow">404 / Not found</div><h1 className="page-title">This page moved.</h1><p className="page-subtitle" style={{ marginBottom: 20 }}>The workspace could not find that route.</p><Link href="/dashboard" className="btn btn-primary" data-testid="link-not-found-dashboard">Return to overview <ArrowRight size={14} /></Link></div></div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/join" component={JoinChapterPage} /><Route path="/dashboard"><ProtectedRoute><AppShell><Dashboard /></AppShell></ProtectedRoute></Route><Route path="/roster"><ProtectedRoute><AppShell><Roster /></AppShell></ProtectedRoute></Route><Route path="/pnms/:id"><ProtectedRoute><AppShell><Profile /></AppShell></ProtectedRoute></Route><Route path="/voting" component={VotingRoute} /><Route path="/archive"><ProtectedRoute><AppShell><ArchivePage /></AppShell></ProtectedRoute></Route><Route path="/approvals"><ProtectedRoute><AppShell><Approvals /></AppShell></ProtectedRoute></Route><Route path="/members"><ProtectedRoute><AppShell><Members /></AppShell></ProtectedRoute></Route><Route path="/activity"><ProtectedRoute><AppShell><ActivityPage /></AppShell></ProtectedRoute></Route><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your VT PGN chapter workspace' } }, signUp: { start: { title: 'Create your account', subtitle: 'Step 1 of 2 · Use your vt.edu email' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to))}><QueryClientProvider client={queryClient}><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkApp /></WouterRouter>;
}

export default App;