#!/usr/bin/env node

/**
 * The jira-changelog CLI
 */

import 'core-js/stable'
import 'regenerator-runtime/runtime'
import 'source-map-support/register'
import program from 'commander'
import path from 'path'
import Slack from './Slack'
import { decodeEntity } from 'html-entities'
import fs from 'fs'

import { generateTemplateData, renderTemplate } from './template'
import { readConfigFile } from './Config'
import SourceControl from './SourceControl'
import Jira from './Jira'
import git from 'simple-git'

/**
 * Parse command line arguments
 */
function commandLineArgs() {
	const pkg = require('../../package.json')
	program
		.version(pkg.version)
		.option('-c, --config <filepath>', 'Path to the config file.')
		.option('-r, --range <from>...<to>', 'git commit range for changelog', parseRange)
		.option('-d, --date <date>[...date]', 'Only include commits after this date', parseRange)
		.option('-s, --slack', 'Automatically post changelog to slack (if configured)')
		.option('--release [release]', 'Assign a release version to these stories')
		.parse(process.argv)
}

/**
 * Run the main program
 */
async function runProgram() {
	try {
		commandLineArgs()

		const options = program.opts()

		// Determine the git workspace path
		let gitPath = process.cwd()
		if (program.args.length) {
			gitPath = program.args[0]
		}
		gitPath = path.resolve(gitPath)

		const config = readConfigFile(gitPath)
		config.gitPath = gitPath
		const jira = new Jira(config)
		const source = new SourceControl()

		const range = await getRangeObject(config, options)

		// Release flag used, but no name passed
		if (options.release === true) {
			if (typeof config.jira.generateReleaseVersionName !== 'function') {
				console.log(
					"You need to define the jira.generateReleaseVersionName function in your config, if you're not going to pass the release version name in the command."
				)
				return
			}
			options.release = await config.jira.generateReleaseVersionName(range)
		}

		// Get logs
		const commitLogs = await source.getCommitLogs(gitPath, range)
		const changelog = await jira.generate(commitLogs, options.release)

		// Render template
		const tmplData = await generateTemplateData(config, changelog, jira.releaseVersions)
		const changelogMessage = renderTemplate(config, tmplData)

		// Output to console
		console.log(decodeEntity(changelogMessage))

		// Save to file
		if (config.save) {
			const filepath = path.join(process.cwd(), 'changelog')
			if (!fs.existsSync(filepath)) {
				await fs.mkdirSync('changelog')
			}
			await fs.writeFileSync(path.join(filepath, `changelog-${options.release || Date.now()}.md`), decodeEntity(changelogMessage))
		}

		// Post to slack
		if (options.slack) {
			await postToSlack(config, tmplData, changelogMessage)
		}
	} catch (e) {
		console.error(e.stack || e)
		process.exit(1)
	}
}

/**
 * Post the changelog to slack
 *
 * @param {Object} config - The configuration object
 * @param {Object} data - The changelog data object.
 * @param {String} changelogMessage - The changelog message
 */
async function postToSlack(config, data, changelogMessage) {
	const slack = new Slack(config)

	if (!slack.isEnabled() || !config.slack.channel) {
		throw new Error('Error: Slack is not configured.')
		return
	}

	console.log(`\nPosting changelog message to slack channel: ${config.slack.channel}...`)
	try {
		// Transform for slack
		if (typeof config.transformForSlack == 'function') {
			changelogMessage = await Promise.resolve(config.transformForSlack(changelogMessage, data))
		}

		// Post to slack
		await slack.postMessage(changelogMessage, config.slack.channel)
		console.log('Sent')
	} catch (err) {
		throw new Error(err)
	}
}

/**
 * Convert a range string formatted as "a...b" into an array.
 *
 * @param {String} rangeStr - The range string.
 * @return {Array}
 */
export function parseRange(rangeStr) {
	let parts = []
	let symmetric = false
	let rangeError = false

	if (rangeStr.includes('...')) {
		if (rangeStr.length <= 3) {
			rangeError = true
		}
		symmetric = true
		parts = rangeStr.split('...')
	} else if (rangeStr.includes('..')) {
		if (rangeStr.length <= 2) {
			rangeError = true
		}
		parts = rangeStr.split('..')
	} else if (rangeStr.length > 0) {
		parts[0] = rangeStr
	}

	if (!parts.length || rangeError) {
		throw new Error('Invalid Range')
	}

	return {
		symmetric,
		from: parts[0],
		to: parts[1] || ''
	}
}

/**
 * Construct the range object from the CLI arguments and config
 *
 * @param {Object} config - The config object provided by Config.getConfigForPath
 * @param {Object} options - Command line arguments parsed in options object
 * @return {Object}
 */
async function getRangeObject(config, options) {
	const range = {}
	const defaultRange = config.sourceControl && config.sourceControl.defaultRange ? config.sourceControl.defaultRange : {}

	if (options.range && options.range.from) {
		Object.assign(range, options.range)
	}
	if (options.dateRange && options.dateRange.from) {
		range.after = options.dateRange.from
		if (options.dateRange.to) {
			range.before = options.dateRange.to
		}
	}

	// Use default range
	if (!Object.keys(range).length && Object.keys(defaultRange).length) {
		Object.assign(range, defaultRange)
	}

	if (Object.keys(range).length < 2) {
		const workspace = git(config.gitPath)

		const { all: allTags } = await workspace.tags()

		if (Object.keys(range).length === 1) {
			const rangeFromTagIndex = range.from ? allTags.findIndex((item) => item === range.from) : null
			const rangeToTagIndex = range.to ? allTags.findIndex((item) => item === range.to) : null

			range.from = range.from ? range.from : allTags[rangeToTagIndex - 1]
			range.to = range.to ? range.to : allTags[rangeFromTagIndex + 1]
		} else {
			range.from = allTags[allTags.length - 2]
			range.to = allTags[allTags.length - 1]
		}
	}

	if (!Object.keys(range).length) {
		throw new Error('No range defined for the changelog.')
	}

	// Ensure symmetric is explicitly set
	range.symmetric = !!range.symmetric
	return range
}

// Run program
if (require.main === module) {
	runProgram()
}
