import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
	packagerConfig: {
		name: 'Pixel Agents',
		executableName: 'pixel-agents',
		asar: true,
		ignore: [
			/^\/main$/,
			/^\/preload$/,
			/^\/node_modules$/,
			/^\/\.git$/,
			/tsconfig\.json$/,
			/esbuild\.electron\.js$/,
			/forge\.config\.ts$/,
		],
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

export default config;
