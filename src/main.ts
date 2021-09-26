import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	FileSystemAdapter,
	getAllTags,
	parseFrontMatterAliases,
	CachedMetadata,
	MetadataCache,
	Notice,
} from 'obsidian';
import { link, writeFileSync } from 'fs';
import { stringify } from 'querystring';
import { captureRejections } from 'events';
interface BridgeSettings {
	writeFilesOnLaunch: boolean;
	writingFrequency: string;
	tagPath: string;
	metadataPath: string;
	tagFile: string;
	metadataFile: string;
}

const DEFAULT_SETTINGS: BridgeSettings = {
	tagPath: '',
	metadataPath: '',
	tagFile: 'tags.json',
	metadataFile: 'metadata.json',
	writingFrequency: '0',
	writeFilesOnLaunch: false,
};

export default class BridgePlugin extends Plugin {
	settings!: BridgeSettings;
	intervalId1: number | undefined = undefined;
	intervalId2: number | undefined = undefined;

	// https://github.com/tillahoffmann/obsidian-jupyter/blob/e1e28db25fd74cd16844b37d0fe2eda9c3f2b1ee/main.ts#L175
	getAbsolutePath(fileName: string): string {
		let basePath;
		let relativePath;
		// base path
		if (this.app.vault.adapter instanceof FileSystemAdapter) {
			basePath = (
				this.app.vault.adapter as FileSystemAdapter
			).getBasePath();
		} else {
			throw new Error('Cannot determine base path.');
		}
		// relative path
		relativePath = `${this.app.vault.configDir}/plugins/metadata-extractor/${fileName}`;
		// absolute path
		return `${basePath}/${relativePath}`;
	}

	getUniqueTags(currentCache: CachedMetadata): string[] {
		let currentTags : string[] = []
		if (getAllTags(currentCache)) {
			//@ts-ignore
			currentTags = getAllTags(currentCache);
		}
		currentTags = currentTags.map((tag) => tag.slice(1).toLowerCase());
		// remove duplicate tags in file
		currentTags = Array.from(new Set(currentTags));
		return currentTags;
	}

	async writeTagsToJSON(fileName: string) {
		let path = this.settings.tagPath;
		// only set the path to the plugin folder if no other path is specified
		if (!this.settings.tagPath) {
			path = this.getAbsolutePath(fileName);
		}

		let tagsCache: { name: string; tags: string[] }[] = [];

		(async () => {
			this.app.vault.getMarkdownFiles().map(async (tfile) => {
				let currentCache! : CachedMetadata;
				if (this.app.metadataCache.getFileCache(tfile) !== null) {
					//@ts-ignore
					currentCache = this.app.metadataCache.getFileCache(tfile);
				}
				let relativePath: string = tfile.path;
				//let displayName: string = this.app.metadataCache.fileToLinktext(tfile, tfile.path, false);
				const currentTags: string[] = this.getUniqueTags(currentCache);
				if (currentTags.length !== 0) {
					tagsCache.push({
						name: relativePath,
						tags: currentTags,
					});
				}
			});
		})();

		// own version of this.app.metadataCache.getTags()
		// it doesn't include subtags if there is only one tag/subtag/subsubtag
		const allTagsFromCache: string[][] = tagsCache.map((element) => {
			return element.tags;
		});
		const reducedAllTagsFromCache = allTagsFromCache.reduce(
			(acc, tagArray) => {
				return acc.concat(tagArray.map((tag) => tag.toLowerCase()));
			}
		);
		const uniqueAllTagsFromCache = Array.from(
			new Set(reducedAllTagsFromCache)
		);

		//@ts-expect-error, private method
		const numberOfNotesWithTag: {} = this.app.metadataCache.getTags();
		// Obsidian doesn' consistently lower case the tags (it's a feature, it shows the most used version)
		interface tagNumber {
			[key: string]: number;
		}
		let tagsWithCount: tagNumber = {};
		for (let [key, value] of Object.entries(numberOfNotesWithTag)) {
			const newKey: string = key.slice(1).toLowerCase();
			const newValue: number = value;
			tagsWithCount[newKey] = newValue;
		}

		let tagToFile: Array<{
			tag: string;
			tagCount: number;
			relativePaths: string[] | string;
		}> = [];
		uniqueAllTagsFromCache.forEach((tag) => {
			const fileNameArray: string[] = [];
			tagsCache.map((fileWithTag) => {
				if (fileWithTag.tags.contains(tag)) {
					fileNameArray.push(fileWithTag.name);
				}
			});
			const numberOfNotes: number = tagsWithCount[tag];
			tagToFile.push({
				tag: tag,
				tagCount: numberOfNotes,
				relativePaths: fileNameArray,
			});
		});

		let content = tagToFile;
		writeFileSync(path, JSON.stringify(content, null, 2));
		console.log('Metadata Extractor plugin: wrote the tagToFile JSON file');
	}

	async writeCacheToJSON(fileName: string) {
		let path = this.settings.metadataPath;
		// only set the path to the plugin folder if no other path is specified
		if (!this.settings.metadataPath) {
			path = this.getAbsolutePath(fileName);
		}
		interface Metadata {
			fileName: string;
			relativePath: string;
			tags?: string[];
			headings?: { heading: string; level: number }[];
			aliases?: string[];
			links?: {
				link: string;
				relativePath?: string;
				cleanLink?: string;
				displayText?: string;
			}[];
			backlinks?: {
				fileName: string;
				relativePath: string;
			}[];
		}

		let metadataCache: Metadata[] = [];

		interface linkToPath {
			[key: string]: string;
		}

		let fileMap: linkToPath = {};
		//@ts-ignore
		for (let [key, value] of Object.entries(this.app.vault.fileMap)) {
			const newKey: string = key;
			let link : string = ''
			if (newKey.slice(-3) === '.md') {
				if (newKey.includes('/')) {
					let split = newKey.split('/').last()
					let isString = typeof(split) === 'string'
					if (isString) {
						//@ts-ignore
						link = split
					}
				}
				link = link.slice(0, -3);
				fileMap[link] = newKey;
			}
		}

		(async () => {
			this.app.vault.getMarkdownFiles().map(async (tfile) => {
				const displayName = tfile.basename;
				const relativeFilePath: string = tfile.path;
				let currentCache! : CachedMetadata;
				if (typeof(this.app.metadataCache.getFileCache(tfile)) !== 'undefined') {
					//@ts-ignore
					currentCache = this.app.metadataCache.getFileCache(tfile)
				} else {
					new Notice('Something with the accessing the cache went wrong!')
				}
				let currentTags: string[];
				let currentAliases: string[];
				let currentHeadings: { heading: string; level: number }[] = [];
				let currentLinks: {
					link: string;
					relativePath?: string;
					cleanLink?: string;
					displayText?: string;
				}[] = [];

				//@ts-expect-error
				let metaObj: Metadata = {};

				metaObj.fileName = displayName;
				metaObj.relativePath = relativeFilePath;

				currentTags = this.getUniqueTags(currentCache);
				if (currentTags !== null) {
					if (currentTags.length > 0) {
						metaObj.tags = currentTags;
					}
				}

				if (currentCache.frontmatter) {
					//@ts-expect-error
					currentAliases = parseFrontMatterAliases(
						currentCache.frontmatter
					);
					if (currentAliases !== null) {
						if (currentAliases.length > 0) {
							metaObj.aliases = currentAliases;
						}
					}
				}

				if (currentCache.headings) {
					currentCache.headings.map((headings) => {
						currentHeadings.push({
							heading: headings.heading,
							level: headings.level,
						});
					});
					metaObj.headings = currentHeadings;
				}

				if (currentCache.links) {
					if (currentCache.embeds) {
						console.log(currentCache.embeds)
					}
					currentCache.links.map((links) => {
						let fullLink = links.link;
						let aliasText : string = ''
						if (typeof(links.displayText) !== 'undefined') {
							aliasText = links.displayText;
						}
						// account for relative links
						if (fullLink.includes('/')) {
							//@ts-ignore
							fullLink = fullLink.split('/').last();
						}
						let path: string = '';
						if (!fullLink.includes('#') && aliasText === fullLink) {
							path = fileMap[fullLink];
							// account for uncreated files
							if (!path) {
								currentLinks.push({
									link: fullLink,
								});
							} else {
								currentLinks.push({
									link: fullLink,
									relativePath: path,
								});
							}
						}
						// heading/block ref and alias, but not to the same file
						else if (
							fullLink.includes('#') &&
							fullLink.charAt(0) !== '#' &&
							(!aliasText.includes('#') ||
								!aliasText.includes('>'))
						) {
							const alias = aliasText;
							const cleanLink = fullLink.replace(/#.+/g, '');
							path = fileMap[cleanLink];
							// account for uncreated files
							if (!path) {
								currentLinks.push({
									link: fullLink,
									cleanLink: cleanLink,
									displayText: alias,
								});
							} else {
								currentLinks.push({
									link: fullLink,
									relativePath: path,
									cleanLink: cleanLink,
									displayText: alias,
								});
							}
						}
						// heading/block ref and no alias, but not to the same file
						else if (
							fullLink.includes('#') &&
							fullLink.charAt(0) !== '#' &&
							aliasText.includes('#')
						) {
							const cleanLink = fullLink.replace(/#.+/g, '');
							path = fileMap[cleanLink];
							// account for uncreated files
							if (!path) {
								currentLinks.push({
									link: fullLink,
									cleanLink: cleanLink,
								});
							} else {
								currentLinks.push({
									link: fullLink,
									relativePath: path,
									cleanLink: cleanLink,
								});
							}
						} // link with alias but not headings
						else if (
							!fullLink.includes('#') &&
							fullLink !== aliasText
						) {
							const alias = aliasText;
							path = fileMap[fullLink];
							// account for uncreated files
							if (!path) {
								currentLinks.push({
									link: fullLink,
									displayText: alias,
								});
							} else {
								currentLinks.push({
									link: fullLink,
									relativePath: path,
									displayText: alias,
								});
							}
						}
						// heading/block ref to same file and alias
						else if (
							fullLink.charAt(0) === '#' &&
							fullLink !== aliasText
						) {
							const alias = aliasText;
							path = relativeFilePath;
							currentLinks.push({
								link: fullLink,
								relativePath: path,
								cleanLink: displayName,
								displayText: alias,
							});
						} // only block ref/heading to same file, no alias
						else if (
							fullLink.charAt(0) === '#' &&
							fullLink === aliasText
						) {
							path = relativeFilePath;
							// account for uncreated files
							currentLinks.push({
								link: fullLink,
								relativePath: path,
							});
						}
					});
					if (currentLinks.length > 0) {
						metaObj.links = currentLinks;
					}
				}

				if (Object.keys(metaObj).length > 0) {
					metadataCache.push(metaObj);
				}
			});
		})();
		//backlinks
		let backlinkObj: {
			fileName: string;
			relativePath: string;
		}[] = [];
		const newMetadataCache = metadataCache;
		metadataCache.map((file) => {
			const fileName = file.fileName;
			const relativeFilePath = file.relativePath;
			newMetadataCache.map((otherFile) => {
				if (fileName !== otherFile.fileName) {
					if (otherFile.links) {
						//something doesn't work here
						//that is because embeds aren't part of the .links in the metadataCache, so when I map over my metadataCache, it doesn't have the link and therefore doesn't find it.
						otherFile.links.map((links) => {
							if (links.relativePath === relativeFilePath) {
								// check if already present, only  push if not present
								backlinkObj.push({
									fileName: otherFile.fileName,
									relativePath: links.relativePath,
								});
							}
						});
					}
				}
			});
			file.backlinks = backlinkObj;
			backlinkObj = [];
		});

		writeFileSync(path, JSON.stringify(metadataCache, null, 2));
		console.log('Metadata Extractor plugin: wrote the metadata JSON file');
	}

	async setWritingSchedule(tagFileName: string, metadataFileName: string) {
		if (this.settings.writingFrequency !== '0') {
			const intervalInMinutes = parseInt(this.settings.writingFrequency);
			let milliseconds = intervalInMinutes * 60000;

			// schedule for tagsToJSON
			window.clearInterval(this.intervalId1);
			this.intervalId1 = undefined;
			this.intervalId1 = window.setInterval(
				() => this.writeTagsToJSON(tagFileName),
				milliseconds
			);
			// API function to cancel interval when plugin unloads
			this.registerInterval(this.intervalId1);

			// schedule for metadataCache to JSON
			window.clearInterval(this.intervalId2);
			this.intervalId2 = undefined;
			this.intervalId2 = window.setInterval(
				() => this.writeCacheToJSON(metadataFileName),
				milliseconds
			);
			// API function to cancel interval when plugin unloads
			this.registerInterval(this.intervalId2);
		} else if (this.settings.writingFrequency === '0') {
			window.clearInterval(this.intervalId1);
			window.clearInterval(this.intervalId2);
		}
	}

	async onload() {
		console.log('loading Metadata Extractor plugin');

		await this.loadSettings();

		this.addCommand({
			id: 'write-tags-json',
			name: 'Write JSON file with tags and associated file names to disk.',
			callback: () => {
				this.writeTagsToJSON(this.settings.tagFile);
			},
		});

		this.addCommand({
			id: 'write-metadata-json',
			name: 'Write JSON file with metadata to disk.',
			callback: () => {
				this.writeCacheToJSON(this.settings.metadataFile);
			},
		});

		this.addSettingTab(new BridgeSettingTab(this.app, this));

		if (this.settings.writeFilesOnLaunch) {
			this.app.workspace.onLayoutReady(() => {
				this.writeTagsToJSON(this.settings.tagFile);
				this.writeCacheToJSON(this.settings.metadataFile);
			});
		}

		await this.setWritingSchedule(
			this.settings.tagFile,
			this.settings.metadataFile
		);
	}

	onunload() {
		console.log('unloading Metadata Extractor plugin');
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class BridgeSettingTab extends PluginSettingTab {
	plugin: BridgePlugin;

	constructor(app: App, plugin: BridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Metadata Extractor Settings' });

		new Setting(containerEl)
			.setName('File-write path for tags')
			.setDesc(
				"Where the tag-to-file-names JSON file will be saved. Requires the file name with extension. \
			If this is filled in, the setting below won't have any effect."
			)
			.addText((text) =>
				text
					.setPlaceholder('/home/user/Downloads/tags.json')
					.setValue(this.plugin.settings.tagPath)
					.onChange(async (value) => {
						this.plugin.settings.tagPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('File name of tag-to-file-names JSON')
			.setDesc(
				'Requires the .json extension. \
			Only change this setting if you want to change the name of the saved json in the plugin folder.'
			)
			.addText((text) =>
				text
					.setPlaceholder('tags.json')
					.setValue(this.plugin.settings.tagFile)
					.onChange(async (value) => {
						this.plugin.settings.tagFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('File-write path for metadata')
			.setDesc(
				"Where the metadata JSON file will be saved. Requires the file name with extension. \
			If this is filled in, the setting below won't have any effect."
			)
			.addText((text) =>
				text
					.setPlaceholder('/home/user/Downloads/metadata.json')
					.setValue(this.plugin.settings.metadataPath)
					.onChange(async (value) => {
						this.plugin.settings.metadataPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('File name of metadata JSON')
			.setDesc(
				'Requires the .json extension; leave empty if setting above was changed. \
			Only change this setting if you want to change the name of the saved json in the plugin folder.'
			)
			.addText((text) =>
				text
					.setPlaceholder('metadata.json')
					.setValue(this.plugin.settings.metadataFile)
					.onChange(async (value) => {
						this.plugin.settings.metadataFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Configure frequency for writing both JSON files')
			.setDesc(
				'The frequency has to be entered in minutes. Set it to 0 to disable the periodic writing.'
			)
			.addText((text) =>
				text
					.setPlaceholder('120')
					.setValue(this.plugin.settings.writingFrequency)
					.onChange(async (value) => {
						if (value === '') {
							this.plugin.settings.writingFrequency = '0';
						} else {
							this.plugin.settings.writingFrequency = value;
						}
						await this.plugin.saveSettings();
						this.plugin.setWritingSchedule(
							this.plugin.settings.tagFile,
							this.plugin.settings.metadataFile
						);
					})
			);

		new Setting(containerEl)
			.setName('Write JSON files automatically when Obsidian launches')
			.setDesc(
				'If enabled, the JSON files will be written each time Obsidian starts.'
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.writeFilesOnLaunch)
					.onChange((state) => {
						this.plugin.settings.writeFilesOnLaunch = state;
						this.plugin.saveSettings();
					});
			});
	}
}
