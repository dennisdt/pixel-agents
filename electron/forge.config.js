const path = require('path');

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	packagerConfig: {
		name: 'Pixel Agents',
		executableName: 'pixel-agents',
		icon: path.join(__dirname, 'icon'),
		asar: true,
		ignore: (filePath) => {
			// Include root package.json and dist/
			if (filePath === '' || filePath === '/package.json') return false;
			if (filePath.startsWith('/dist')) return false;
			// Exclude everything else (source, node_modules except runtime deps, configs)
			return true;
		},
	},
	makers: [
		{
			name: '@electron-forge/maker-zip',
			platforms: ['darwin'],
		},
		{
			name: '@electron-forge/maker-dmg',
			config: {
				format: 'ULFO',
			},
		},
	],
};
