import { type AppInfo, allowsIsolated, type PermissionState, runtimeFeatures } from "@iyowa/sdk";
import {
	Button,
	Code,
	Divider,
	Group,
	type MantineColorScheme,
	Modal,
	NativeSelect,
	Progress,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	useMantineColorScheme,
} from "@mantine/core";
import { type FormEvent, useEffect, useState } from "react";
import { AppIcon } from "./components.tsx";
import { formatBytes } from "./runtime.ts";

const SCHEMES: { value: MantineColorScheme; label: string }[] = [
	{ value: "auto", label: "Match the system" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];
const ACCESS: { value: PermissionState; label: string }[] = [
	{ value: "prompt", label: "Ask" },
	{ value: "granted", label: "Allow" },
	{ value: "denied", label: "Block" },
];

export function SettingsDialog(props: {
	opened: boolean;
	app?: AppInfo;
	onClose(): void;
	onPermission(app: AppInfo, state: PermissionState): void;
	onUpdate(app: AppInfo): Promise<void>;
	onRemove(app: AppInfo): void;
	onOpen(app: AppInfo, path: string): void;
}) {
	const { app } = props;
	const { colorScheme, setColorScheme } = useMantineColorScheme();
	const [confirming, setConfirming] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [manifest, setManifest] = useState(false);
	useEffect(() => {
		if (!props.opened) return;
		setConfirming(false);
		setManifest(false);
	}, [props.opened]);
	const local =
		app &&
		(allowsIsolated(app.manifest, "direct-sockets-private", app.id) ||
			allowsIsolated(app.manifest, "controlled-frame", app.id));
	const features = Object.keys(app?.manifest.permissions_policy ?? {});
	const update = async () => {
		if (!app) return;
		setUpdating(true);
		try {
			await props.onUpdate(app);
		} finally {
			setUpdating(false);
		}
	};
	return (
		<Modal opened={props.opened} onClose={props.onClose} title="Settings" size="lg">
			<Stack gap="md">
				<NativeSelect
					id="color-scheme"
					label="Appearance"
					data={SCHEMES}
					value={colorScheme}
					onChange={(event) => setColorScheme(event.currentTarget.value as MantineColorScheme)}
				/>
				{app ? (
					<>
						<Divider />
						<Group gap="sm" wrap="nowrap">
							<AppIcon app={app} size={36} />
							<div>
								<Text size="sm" fw={600}>
									{app.name} {app.version}
								</Text>
								<Text size="xs" c="dimmed">
									{formatBytes(app.size)} · {app.exchanges.toLocaleString()} resources ·
									signature verified
								</Text>
							</div>
						</Group>
						{local && (
							<NativeSelect
								id="local-network"
								label="Local network access"
								description="Connect to this computer and devices on your network, and accept connections. Blocked apps keep their sockets inside the app, and their frames load public sites only."
								data={ACCESS}
								value={app.permissions["local-network"]}
								onChange={(event) =>
									props.onPermission(app, event.currentTarget.value as PermissionState)
								}
							/>
						)}
						<div>
							<Text size="sm" fw={500} mb={4}>
								Declared in the manifest
							</Text>
							{features.length ? (
								<Stack gap={2}>
									{features.map((feature) => (
										<Text key={feature} size="xs">
											<code>{feature}</code>{" "}
											<Text span size="xs" c="dimmed">
												{runtimeFeatures[feature] ??
													"Browser feature, subject to the browser's own prompts"}
											</Text>
										</Text>
									))}
								</Stack>
							) : (
								<Text size="xs" c="dimmed">
									No policy-controlled features.
								</Text>
							)}
						</div>
						<dl className="facts">
							<dt>Bundle ID</dt>
							<dd>
								<code>{app.id}</code>
							</dd>
							<dt>Origin</dt>
							<dd>
								<code>{app.origin}</code>
							</dd>
							<dt>Runs at</dt>
							<dd>
								<code>{app.appOrigin}</code>
							</dd>
							<dt>SHA-256</dt>
							<dd>
								<code>{app.digest}</code>
							</dd>
							<dt>Installed</dt>
							<dd>{new Date(app.installedAt).toLocaleString()}</dd>
							{app.manifest.update_manifest_url && (
								<>
									<dt>Updates</dt>
									<dd>
										<code>{app.manifest.update_manifest_url}</code>
									</dd>
								</>
							)}
						</dl>
						{(app.manifest.shortcuts?.length ?? 0) > 0 && (
							<Group gap="xs">
								<Text size="sm" fw={500}>
									Shortcuts
								</Text>
								{app.manifest.shortcuts?.map((s) => (
									<Button
										key={s.url + s.name}
										size="compact-xs"
										variant="light"
										onClick={() => props.onOpen(app, s.url)}
									>
										{s.name}
									</Button>
								))}
							</Group>
						)}
						{manifest && (
							<ScrollArea.Autosize mah={240} type="auto">
								<Code block>{JSON.stringify(app.manifest, null, 2)}</Code>
							</ScrollArea.Autosize>
						)}
						<Group justify="space-between" wrap="nowrap" align="flex-start">
							<Group gap="xs">
								<Button size="xs" variant="default" onClick={() => setManifest((v) => !v)}>
									{manifest ? "Hide manifest" : "View manifest"}
								</Button>
								{app.manifest.update_manifest_url && (
									<Button
										size="xs"
										variant="default"
										loading={updating}
										onClick={() => void update()}
									>
										Check for updates
									</Button>
								)}
							</Group>
							{confirming ? (
								<Group gap="xs" wrap="nowrap">
									<Button size="xs" variant="default" onClick={() => setConfirming(false)}>
										Keep
									</Button>
									<Button
										id="confirm-remove"
										size="xs"
										color="red"
										onClick={() => props.onRemove(app)}
									>
										Remove app
									</Button>
								</Group>
							) : (
								<Button
									id="remove-app"
									size="xs"
									color="red"
									variant="light"
									onClick={() => setConfirming(true)}
								>
									Remove app
								</Button>
							)}
						</Group>
					</>
				) : (
					<Text size="sm" c="dimmed">
						Install an app to see its permissions and details here.
					</Text>
				)}
				<Group justify="flex-end" mt="xs">
					<Button onClick={props.onClose}>Done</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

export function URLDialog(props: { opened: boolean; onClose(): void; onInstall(url: string): void }) {
	const [url, setURL] = useState("");
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (!props.opened) return;
		setURL("");
		setError(undefined);
	}, [props.opened]);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const parsed = URL.parse(url.trim());
		if (parsed?.protocol !== "https:") return setError("Enter a public https:// URL.");
		props.onInstall(parsed.href);
	};
	return (
		<Modal opened={props.opened} onClose={props.onClose} title="Install from URL" size="md">
			<form id="url-form" onSubmit={submit}>
				<Stack gap="md">
					<TextInput
						id="bundle-url"
						label="Bundle or update manifest URL"
						description="A signed web bundle (.swbn), or an update manifest (update.json), which installs its newest version."
						placeholder="https://example.com/app/update.json"
						value={url}
						error={error}
						autoComplete="off"
						spellCheck={false}
						data-autofocus
						onChange={(event) => setURL(event.currentTarget.value)}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={props.onClose}>
							Cancel
						</Button>
						<Button type="submit">Install</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	);
}

export function InstallProgress(props: { message?: string }) {
	const [last, setLast] = useState(props.message);
	useEffect(() => {
		if (props.message) setLast(props.message);
	}, [props.message]);
	return (
		<Modal
			opened={Boolean(props.message)}
			onClose={() => {}}
			withCloseButton={false}
			closeOnClickOutside={false}
			closeOnEscape={false}
			centered
			title="Installing app"
		>
			<Text id="install-status" role="status" size="sm">
				{props.message || last}
			</Text>
			<Progress value={100} animated striped size="sm" mt="md" />
		</Modal>
	);
}
