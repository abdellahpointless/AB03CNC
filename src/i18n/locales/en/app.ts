/* English texts: app (app shell, sign-in, account security, user management). */
const app = {
  loading: 'Loading CNC Process Pro...',
  loadingAnalytics: 'Loading analytics...',

  header: {
    subtitle: 'Industrial G-Code Dialect & Tool Remapper',
    syncTitle: 'CNC Process Pro - Click to sync now',
    securityTitle: 'Account security (password, two-step sign-in)',
    syncNow: 'Sync now',
    signOut: 'Sign Out',
  },

  ending: {
    title: 'End of shift soon',
    banner: 'Shift ends at {{time}}. Do your end of shift tasks:',
    tasks_one: '{{count}} task',
    tasks_other: '{{count}} tasks',
    doNow: 'Do them now',
    body: 'Shift ends at {{time}}. Still to do: {{list}}',
  },

  lock: {
    title: 'Do your checks first',
    help: "The rest of the app opens once your machines' checks and this shift's cales box are done.",
    checks_one: '{{count}} check',
    checks_other: '{{count}} checks',
    cales: 'cales box',
  },

  banners: {
    weakPassword:
      'Your password no longer meets the security rules (at least {{min}} characters, not a common password). The app is reachable from the internet, so please choose a stronger one.',
    mfaNudge: 'Protect your admin account with two-step sign-in: a code from your phone is asked after the password.',
    turnOn: 'Turn on',
    offline:
      'No connection to the server. You can keep remapping with the last saved tool inventory; history uploads automatically when the connection returns.',
  },

  tabs: {
    toolInventory: 'Tool Inventory',
    remapper: 'Tool Remapper',
    history: 'History',
    recentCodes: 'Recent Codes',
    partEntry: 'Part without scan',
    preventive: 'Preventive actions',
    partReview: 'Part review',
    admin: 'Admin: Analytics, Users & Data',
  },

  /** History lives inside the Tool Remapper (a button), not in the tab bar. */
  remapHistory: {
    open: 'History',
    openTitle: 'Every exported program, by everyone',
    back: 'Back to Tool Remapper',
  },
  /** Part review appears under "Part without scan" when an admin points at it. */
  subTabs: {
    partEntryMenu: 'More in Part without scan',
  },

  theme: {
    label: {
      dark: 'Dark mode',
      light: 'Light mode',
      system: 'Follow Windows setting',
    },
    /** The mode a click switches to, inside the button tooltip. */
    nextLabel: {
      dark: 'dark mode',
      light: 'light mode',
      system: 'follow windows setting',
    },
    title: '{{current}} (click for {{next}})',
    aria: 'Colour mode: {{mode}}',
  },

  /** Error texts used when the server sends no message of its own. */
  auth: {
    loginFailed: 'Login failed',
    setupFailed: 'Setup failed',
    wrongCode: 'Wrong code',
    signInExpired: 'Sign-in expired. Please enter your password again.',
  },

  login: {
    scanHint: 'Sign in to open the checks of {{machine}}',
    tagline: 'Industrial Dialect & Tool Engine',
    noMasterTitle: 'No master account yet.',
    noMasterBody: "A Moroccan admin creates it in Admin → Master admin account. Then sign in here, or from any country's login page.",
    notSetUpTitle: 'This country is not set up yet.',
    notSetUpBody: 'The master admin creates its first admin account from the master dashboard. The master admin can sign in here.',
    setupTitle: 'First-time setup.',
    setupBody:
      'Create the administrator account for this installation. You can then import your old data (Admin → Data & Migration) and add operators.',
    recoveryHint: 'Enter one of the recovery codes you saved when you turned on two-step sign-in. Each code works once.',
    appHint: 'Open your authenticator app and enter the 6-digit code for CNC Process Pro.',
    recoveryCode: 'Recovery code',
    authenticatorCode: 'Authenticator code',
    checking: 'Checking...',
    verifyAndSignIn: 'Verify and sign in',
    useApp: 'Use the authenticator app',
    useRecovery: 'Lost your phone? Use a recovery code',
    username: 'Username',
    usernameSetupPlaceholder: 'Choose an admin username',
    usernamePlaceholder: 'Enter username',
    password: 'Password',
    minTenChars: 'At least 10 characters',
    secureAccess: 'Secure Access',
    confirmPassword: 'Confirm Password',
    creatingAccount: 'Creating account...',
    signingIn: 'Signing in...',
    createAdmin: 'Create Admin Account',
    signInToSystem: 'Sign In to System',
    passwordsMismatch: 'The two passwords do not match',
    roleBasedSecurity: 'Role-Based Security',
  },

  security: {
    title: 'Account security',
    tabPassword: 'Password',
    tabMfa: 'Two-step sign-in',
    qrAria: 'QR code for the authenticator app',
    // Password tab
    passwordsMismatch: 'The new passwords do not match',
    changeFailed: 'Could not change the password',
    passwordChanged: 'Password changed. Other PCs using this account were signed out.',
    currentPassword: 'Current password',
    newPassword: 'New password (at least {{min}} characters)',
    repeatPassword: 'Repeat new password',
    passwordTip: 'A short sentence is easier to remember and harder to guess than a single word. Avoid your username and common passwords.',
    changePassword: 'Change password',
    // Recovery codes
    recoveryFileTitle: 'CNC Process Pro recovery codes',
    recoveryFileNote: 'Each code can be used once if you lose your phone.',
    mfaOn: 'Two-step sign-in is on.',
    recoverySave:
      'Save these recovery codes somewhere safe (printed, or in a password manager). If you lose your phone, each code lets you sign in once.',
    recoveryShownOnce: 'They are shown only now.',
    copied: 'Copied',
    copy: 'Copy',
    savedThem: 'I saved them',
    // Two-step sign-in tab
    mfaOnForAccount: 'Two-step sign-in is on for this account.',
    turnOffHint: 'To turn it off, confirm your password and a current code (or a recovery code).',
    password: 'Password',
    codeOrRecovery: '6-digit code or recovery code',
    turningOff: 'Turning off...',
    turnOff: 'Turn off two-step sign-in',
    intro:
      'With two-step sign-in, your password alone is not enough: you also enter a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password...). Strongly recommended for admin accounts.',
    preparing: 'Preparing...',
    turnOn: 'Turn on two-step sign-in',
    step1: '1. Scan this code with your authenticator app.',
    cantScan: "Can't scan? Enter this key by hand",
    step2: '2. Enter the 6-digit code it shows, and your password.',
    checking: 'Checking...',
    confirmTurnOn: 'Confirm and turn on',
  },

  users: {
    title: 'User & Operator Management',
    subtitle:
      'Provision machinist and administrator accounts across the shop floor. Passwords are stored as salted hashes; every sign-in and account change is logged below.',
    accessRestricted: 'Access Restricted',
    noPermission: 'You do not have permission to view operator account administration.',
    loadFailed: 'Could not load accounts',
    requestFailed: 'Request failed',
    addTitle: 'Add New Account',
    username: 'Username',
    usernamePlaceholder: 'e.g. machinist_1',
    password: 'Password',
    passwordPlaceholder: 'at least {{min}} characters',
    role: 'Role',
    addAccount: 'Add Account',
    registered: 'Registered Accounts',
    userCount: '{{n}} users',
    loadingAccounts: 'Loading accounts...',
    colUser: 'User',
    colRole: 'Role',
    colActions: 'Actions',
    you: 'you',
    mfaOnTitle: 'Two-step sign-in is on',
    twoStep: '2-step',
    ownRoleTitle: 'You cannot change your own role',
    changeRoleTitle: 'Change role',
    /** Role names in the role drop-down of the accounts table (shown in capitals). */
    roleUpper: {
      MACHINIST: 'MACHINIST',
      ADMIN: 'ADMIN',
    },
    resetMfaTitle: 'Reset two-step sign-in (lost phone)',
    setPasswordTitle: 'Set a new password',
    deleteTitle: 'Delete User',
    created: 'Account "{{name}}" created.',
    confirmDelete: 'Delete the account "{{name}}"? Their history and part entries are kept.',
    deleted: 'Account "{{name}}" deleted.',
    promptPassword: 'New password for "{{name}}" (at least {{min}} characters):',
    passwordReset: 'Password for "{{name}}" changed. They are signed out on other PCs.',
    confirmResetMfa: 'Turn off two-step sign-in for "{{name}}"? Use this when they lost their phone. They can turn it on again after signing in.',
    mfaReset: 'Two-step sign-in reset for "{{name}}".',
    nowAdmin: '"{{name}}" is now ADMIN.',
    nowMachinist: '"{{name}}" is now MACHINIST.',
    log: {
      title: 'Security log',
      hide: 'Hide',
      show: 'Show sign-ins and account changes',
      loadFailed: 'Could not load the security log',
      colWhen: 'When',
      colWho: 'Who',
      colWhat: 'What',
      colIp: 'IP address',
      empty: 'No events yet.',
      /** Security log entries (by the action recorded on the server). */
      actions: {
        login: 'Signed in',
        loginFailed: 'Wrong password',
        mfaFailed: 'Wrong 2-step code',
        passwordCheckFailed: 'Wrong current password',
        passwordChanged: 'Changed own password',
        mfaEnabled: 'Turned on 2-step sign-in',
        mfaDisabled: 'Turned off 2-step sign-in',
        userCreated: 'Created account',
        userUpdated: 'Changed account',
        userDeleted: 'Deleted account',
        adminAction: 'Admin change',
        adminDenied: 'Blocked admin request',
        setup: 'First setup',
      },
    },
  },

  /** Units of the "time won" counters: 4m 45s, 2h 05m 10s, 3d 4h 12m. */
  timeWon: {
    days: '{{n}}d',
    hours: '{{n}}h',
    minutes: '{{n}}m',
    seconds: '{{n}}s',
  },
};
export default app;
