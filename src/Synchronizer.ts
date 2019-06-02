import * as request from "request";
import * as cheerio from "cheerio";
import * as magnet from "magnet-uri";
import {Catalog} from "./Catalog";
import {CronJob} from "cron";
import {Movie} from "./Movie";

const Stremio = require("stremio-addons");

export class Synchronizer {

    private static _repositoryPages: any = {tail: [], done: [], failed: []};
    private static _repositoryTorrents: any = {tail: [], done: [], failed: []};
    private static _movies: Movie[] = [];
    private static _working: any = {gettingPage: false, scrapDetails: false, scrapTorrents: false, consolidating: false};
    private static _url: string = "https://www.cinecalidad.to/page/";
    private static _imdbRegex = /imdb\.com\/title\/tt[0-9]+\//;
    private static _lastScrappedMovie: any;
    private static _page: number = 1;
    private static _maxPage: number = Number(process.env.MAX_PAGE) || 10;
    private static _forceFinish: boolean = false;
    private static _cinemataEndpoint = "http://cinemeta.strem.io/stremioget/stremio/v1";
    private static _imdbMovieDetails = "https://www.imdb.com/title/";
    private static _addons: any;

    public static Initialize(runNow: boolean = false): void {
        new CronJob(process.env.CRON_EXPRESSION || '1 1 * * * *', () => {
            this.run();
        }, null, true);

        if (runNow) {
            this.run();
        }

        this._addons = new Stremio.Client();
        this._addons.add(this._cinemataEndpoint);
    }

    private static run(): void {
        this._forceFinish = false;
        this._page = 1;
        this._lastScrappedMovie = Catalog.getTop10Movies();
        this.getPage(this._url + this._page);
    }

    private static getPage(url: string) {
        if (this._forceFinish) {
            this._working.gettingPage = false;
            this.scrapTorrents();
        } else if (!this._working.gettingPage) {
            this._working.gettingPage = true;
            request.get(url, {timeout: 5000},
                (error, response, html) => {
                    if (error) {
                        throw error;
                    } else {
                        if (html.includes("No se encontró la dirección") || this._page > this._maxPage) {
                            this._working.gettingPage = false;
                            this.scrapTorrents();
                        } else {
                            let $ = cheerio.load(html);

                            let posts = $("#main_container .home_post_cont");
                            for (let i = 0; i < posts.length; i++) {
                                this._repositoryPages.tail.push(posts[i].children[1].attribs.href);
                            }

                            this._working.gettingPage = false;
                            this._page++;
                            this.scrapDetails();
                        }
                    }
                });
        }
    }

    private static scrapDetails() {
        if (!this._working.scrapDetails) {
            if (this._repositoryPages.tail.length > 0) {
                console.log(`Getting details from page ${this._page - 1} movie ${this._repositoryPages.done.length + 1}`);
                this._working.scrapDetails = true;
                let url = this._repositoryPages.tail[0];

                try {
                    request.get({
                        uri: url,
                        timeout: 15000
                    }, (error, response, html) => {
                        if (error) {
                            console.error(`Get detail fail for ${url}`);
                            this._repositoryPages.failed.push(url);
                            this._repositoryPages.tail.splice(0, 1);
                            this._working.scrapDetails = false;
                            this.scrapDetails();
                        } else {
                            let $ = cheerio.load(html);

                            let linkList = $("#main_container #panel_descarga .linklist")[0].children;
                            for (let i = 0; i < linkList.length; i++) {
                                let item = linkList[i];
                                if (item.hasOwnProperty("attribs")) {
                                    if (item.attribs.class === "link" && item.attribs.service === "BitTorrent") {
                                        try {
                                            let imdb = this._imdbRegex.exec(html)[0].split('/')[2];
                                            if (this.isInLastScrapped10Movies(imdb)) {
                                                this._repositoryPages.tail = [];
                                                this._forceFinish = true;
                                            } else {
                                                this._repositoryTorrents.tail.push({imdb, url: `https://www.cinecalidad.to${item.attribs.href}`, failed: 0});
                                            }
                                        } catch (e) {
                                            console.log("A not valid IMDB Movie");
                                        }
                                    }
                                }
                            }
                            this._repositoryPages.done.push(url);
                            this._repositoryPages.tail.splice(0, 1);
                            this._working.scrapDetails = false;
                            this.scrapDetails();
                        }
                    });
                } catch (e) {
                    console.error(`Get detail fail for ${url}`);
                    this._repositoryPages.failed.push(url);
                    this._repositoryPages.tail.splice(0, 1);
                    this._working.scrapDetails = false;
                    this.scrapDetails();
                }
            } else {
                this.getPage(this._url + this._page);
            }
        }
    }

    private static scrapTorrents() {
        if (!this._working.scrapTorrents) {
            if (this._repositoryTorrents.tail.length > 0) {
                console.log("Getting torrent " + (this._repositoryTorrents.done.length + 1));
                this._working.scrapTorrents = true;
                let torrent = this._repositoryTorrents.tail[0];

                try {
                    request.get({
                        uri: torrent.url,
                        timeout: 15000
                    }, async (error, response, html) => {
                        if (error) {
                            this.scrapTorrentsFailHandler(torrent);
                        } else {
                            let $ = cheerio.load(html);

                            let magnet = this.magnetTransform("movie", $("#contenido #texto input")[0].attribs.value);
                            let meta = await this.getMovieMeta(this._repositoryTorrents.tail[0].imdb);

                            if (meta && magnet) {
                                let newMovie = new Movie({
                                    id: this._repositoryTorrents.tail[0].imdb,
                                    name: meta.name,
                                    release_date: null,
                                    runtime: 0,
                                    type: "movie",
                                    year: meta.year,
                                    info_hash: magnet.infoHash,
                                    sources: magnet.sources,
                                    tags: magnet.tag,
                                    title: magnet.title,
                                    poster: meta.poster
                                });

                                this._movies.push(newMovie);
                            }

                            this._repositoryTorrents.done.push(torrent);
                            this._repositoryTorrents.tail.splice(0, 1);
                            this._working.scrapTorrents = false;
                            this.scrapTorrents();
                        }
                    });
                } catch (e) {
                    this.scrapTorrentsFailHandler(torrent);
                }

            } else {
                this._movies.reverse().forEach((movie: Movie) => {
                    movie.save();
                });
                console.log("Process Done");
            }
        }
    }

    private static scrapTorrentsFailHandler(torrent: any) {
        torrent.failed++;
        console.error(`Get torrent fail ${torrent.failed} times for ${torrent.imdb} retrying.`);

        if (torrent.failed > 9) {
            this._repositoryTorrents.tail.splice(0, 1);
            this._repositoryTorrents.failed.push(torrent);
            this._working.scrapTorrents = false;
            this.scrapTorrents();
        }

        setTimeout(() => {
            this.scrapTorrents();
        }, 5000);
    }

    private static magnetTransform(type: string, uri: string): any {
        const parsed = magnet.decode(uri);
        const infoHash = parsed.infoHash.toLowerCase();
        const tags = [];
        if (uri.match(/720p/i)) tags.push("720p");
        if (uri.match(/1080p/i)) tags.push("1080p");
        return {
            type: type,
            infoHash: infoHash,
            sources: (parsed.announce || []).map(function (x) {
                return "tracker:" + x
            }).concat(["dht:" + infoHash]),
            tag: tags,
            title: tags[0] + " Español / English", // show quality in the UI
        }
    }

    private static isInLastScrapped10Movies(imdb: string): boolean {
        for (let movie of this._lastScrappedMovie) {
            if (movie.id === imdb) {
                return true;
            }
        }

        return false;
    }

    public static getMovieMeta(imdb_id: string): Promise<any> {
        return new Promise(resolve => {
            try {
                request.get({
                    uri: this._imdbMovieDetails + imdb_id,
                    timeout: 15000
                }, async (error, response, html) => {
                    if (error) {
                        resolve({});
                    } else {
                        let $ = cheerio.load(html);

                        let name = $("div.title_wrapper h1")[0].children[0].data;
                        let year = $("span#titleYear")[0].children[1].children[0].data;

                        let posterSrc = $("div.poster a img")[0].attribs.src;
                        let poster = posterSrc.substring(0, posterSrc.indexOf("@._V1_") + 6) + "SX300.jpg";

                        resolve({poster, name, year});
                    }
                });
            } catch (e) {
                resolve({});
            }
        })
    }
}


