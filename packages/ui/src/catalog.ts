/** Public Isolated Web Apps that install straight from their publishers' URLs. */
export interface CatalogEntry {
	id: string;
	name: string;
	publisher: string;
	description: string;
	url: string;
	source: string;
}

export const catalog: CatalogEntry[] = [
	{
		id: "aiv4bxauvcu3zvbu6r5yynoh4atkzqqaoeof5mwz54b4zfywcrjuoaacai",
		name: "IWA Kitchen Sink",
		publisher: "ChromeOS",
		description:
			"Direct Sockets, Controlled Frame, screen capture, unframed windows and an OAuth loopback flow.",
		url: "https://github.com/chromeos/iwa-sink/releases/latest/download/update.json",
		source: "https://github.com/chromeos/iwa-sink",
	},
	{
		id: "beb7diqffhi5yc5hqyck245ulcjmklysjgburdf735ix4wkzasbaaaic",
		name: "IWA Windowing Example",
		publisher: "Mike Wasserman",
		description: "Display modes, window management, fullscreen and popups.",
		url: "https://raw.githubusercontent.com/michaelwasserman/iwa-windowing-example/main/iwa-windowing-example.swbn",
		source: "https://github.com/michaelwasserman/iwa-windowing-example",
	},
	{
		id: "drhxtelgnohhj4bsouat44nzzchtxplomosg7pgni6wqtju6qp6aaaic",
		name: "IWA Bundling Example",
		publisher: "Mike Wasserman",
		description: "The minimal signed bundle from the IWA bundling tutorial.",
		url: "https://raw.githubusercontent.com/michaelwasserman/iwa-bundling-example/main/iwa-bundling-example.swbn",
		source: "https://github.com/michaelwasserman/iwa-bundling-example",
	},
];
