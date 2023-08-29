import { cloneDeep, assign } from "lodash";
import {
  GraphQLError,
  ExecutionResult,
  DocumentNode,
  Kind,
  print,
  visit,
} from "graphql";
import gql from "graphql-tag";

import {
  ApolloClient,
  FetchPolicy,
  WatchQueryFetchPolicy,
  QueryOptions,
  ObservableQuery,
  Operation,
  TypedDocumentNode,
  NetworkStatus,
} from "../core";

import {
  DocumentTransform,
  Observable,
  ObservableSubscription,
  offsetLimitPagination,
  removeDirectivesFromDocument,
} from "../utilities";
import { ApolloLink } from "../link/core";
import {
  createFragmentRegistry,
  InMemoryCache,
  makeVar,
  PossibleTypesMap,
} from "../cache";
import { ApolloError } from "../errors";

import {
  itAsync,
  subscribeAndCount,
  mockSingleLink,
  withErrorSpy,
  MockLink,
  wait,
} from "../testing";
import { waitFor } from "@testing-library/react";

describe("client", () => {
  it("can be loaded via require", () => {
    /* tslint:disable */
    const ApolloClientRequire = require("../").ApolloClient;
    /* tslint:enable */

    const client = new ApolloClientRequire({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    expect(client.queryManager).toBeDefined();
    expect(client.cache).toBeDefined();
  });

  it("can allow passing in a link", () => {
    const link = ApolloLink.empty();
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    expect(client.link).toBeInstanceOf(ApolloLink);
  });

  it('should throw an error if query option is missing or not wrapped with a "gql" tag', () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    expect(() => {
      client.query(
        gql`
          {
            a
          }
        ` as any
      );
    }).toThrowError(
      "query option is required. You must specify your GraphQL document in the query option."
    );
    expect(() => {
      client.query({ query: "{ a }" } as any);
    }).toThrowError('You must wrap the query string in a "gql" tag.');
  });

  it("should throw an error if mutation option is missing", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    return await expect(
      client.mutate({
        query: gql`
          {
            a
          }
        `,
      } as any)
    ).rejects.toThrow(
      "mutation option is required. You must specify your GraphQL document in the mutation option."
    );
  });

  itAsync(
    "should allow for a single query to take place",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
              __typename
            }
            __typename
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
              __typename: "Person",
            },
          ],
          __typename: "People",
        },
      };

      return clientRoundtrip(resolve, reject, query, { data });
    }
  );

  itAsync(
    "should allow a single query with an apollo-link enabled network interface",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
              __typename
            }
            __typename
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
              __typename: "Person",
            },
          ],
          __typename: "People",
        },
      };

      const variables = { first: 1 };

      const link = ApolloLink.from([() => Observable.of({ data })]);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      client.query({ query, variables }).then((actualResult) => {
        expect(actualResult.data).toEqual(data);
        resolve();
      });
    }
  );

  itAsync(
    "should allow for a single query with complex default variables to take place",
    (resolve, reject) => {
      const query = gql`
        query stuff(
          $test: Input = { key1: ["value", "value2"], key2: { key3: 4 } }
        ) {
          allStuff(test: $test) {
            people {
              name
            }
          }
        }
      `;

      const result = {
        allStuff: {
          people: [
            {
              name: "Luke Skywalker",
            },
            {
              name: "Jabba The Hutt",
            },
          ],
        },
      };

      const variables = {
        test: { key1: ["value", "value2"], key2: { key3: 4 } },
      };

      const link = mockSingleLink({
        request: { query, variables },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const basic = client.query({ query, variables }).then((actualResult) => {
        expect(actualResult.data).toEqual(result);
      });

      const withDefault = client.query({ query }).then((actualResult) => {
        expect(actualResult.data).toEqual(result);
      });

      return Promise.all([basic, withDefault]).then(resolve, reject);
    }
  );

  itAsync(
    "should allow for a single query with default values that get overridden with variables",
    (resolve, reject) => {
      const query = gql`
        query people($first: Int = 1) {
          allPeople(first: $first) {
            people {
              name
            }
          }
        }
      `;

      const variables = { first: 1 };
      const override = { first: 2 };

      const result = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
          ],
        },
      };

      const overriddenResult = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
            {
              name: "Jabba The Hutt",
            },
          ],
        },
      };

      const link = mockSingleLink(
        {
          request: { query, variables },
          result: { data: result },
        },
        {
          request: { query, variables: override },
          result: { data: overriddenResult },
        }
      ).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const basic = client.query({ query, variables }).then((actualResult) => {
        expect(actualResult.data).toEqual(result);
      });

      const withDefault = client.query({ query }).then((actualResult) => {
        return expect(actualResult.data).toEqual(result);
      });

      const withOverride = client
        .query({ query, variables: override })
        .then((actualResult) => {
          return expect(actualResult.data).toEqual(overriddenResult);
        });

      return Promise.all([basic, withDefault, withOverride]).then(
        resolve,
        reject
      );
    }
  );

  itAsync("should allow fragments on root query", (resolve, reject) => {
    const query = gql`
      query {
        ...QueryFragment
      }

      fragment QueryFragment on Query {
        records {
          id
          name
          __typename
        }
        __typename
      }
    `;

    const data = {
      records: [
        { id: 1, name: "One", __typename: "Record" },
        { id: 2, name: "Two", __typename: "Record" },
      ],
      __typename: "Query",
    };

    return clientRoundtrip(resolve, reject, query, { data }, null);
  });

  itAsync(
    "should allow fragments on root query with ifm",
    (resolve, reject) => {
      const query = gql`
        query {
          ...QueryFragment
        }

        fragment QueryFragment on Query {
          records {
            id
            name
            __typename
          }
          __typename
        }
      `;

      const data = {
        records: [
          { id: 1, name: "One", __typename: "Record" },
          { id: 2, name: "Two", __typename: "Record" },
        ],
        __typename: "Query",
      };

      return clientRoundtrip(resolve, reject, query, { data }, null, {
        Query: ["Record"],
      });
    }
  );

  itAsync("should merge fragments on root query", (resolve, reject) => {
    // The fragment should be used after the selected fields for the query.
    // Otherwise, the results aren't merged.
    // see: https://github.com/apollographql/apollo-client/issues/1479
    const query = gql`
      query {
        records {
          id
          __typename
        }
        ...QueryFragment
      }

      fragment QueryFragment on Query {
        records {
          name
          __typename
        }
        __typename
      }
    `;

    const data = {
      records: [
        { id: 1, name: "One", __typename: "Record" },
        { id: 2, name: "Two", __typename: "Record" },
      ],
      __typename: "Query",
    };

    return clientRoundtrip(resolve, reject, query, { data }, null, {
      Query: ["Record"],
    });
  });

  itAsync("store can be rehydrated from the server", (resolve, reject) => {
    const query = gql`
      query people {
        allPeople(first: 1) {
          people {
            name
          }
        }
      }
    `;

    const data = {
      allPeople: {
        people: [
          {
            name: "Luke Skywalker",
          },
        ],
      },
    };

    const link = mockSingleLink({
      request: { query },
      result: { data },
    }).setOnError(reject);

    const initialState: any = {
      data: {
        ROOT_QUERY: {
          'allPeople({"first":1})': {
            people: [
              {
                name: "Luke Skywalker",
              },
            ],
          },
        },
        optimistic: [],
      },
    };

    const finalState = assign({}, initialState, {});

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }).restore(
        initialState.data
      ),
    });

    return client
      .query({ query })
      .then((result) => {
        expect(result.data).toEqual(data);
        expect(finalState.data).toEqual(
          (client.cache as InMemoryCache).extract()
        );
      })
      .then(resolve, reject);
  });

  itAsync(
    "store can be rehydrated from the server using the shadow method",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
          ],
        },
      };

      const link = mockSingleLink({
        request: { query },
        result: { data },
      }).setOnError(reject);

      const initialState: any = {
        data: {
          ROOT_QUERY: {
            'allPeople({"first":1})': {
              people: [
                {
                  name: "Luke Skywalker",
                },
              ],
            },
          },
          optimistic: [],
        },
      };

      const finalState = assign({}, initialState, {});

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }).restore(
          initialState.data
        ),
      });

      return client
        .query({ query })
        .then((result) => {
          expect(result.data).toEqual(data);
          expect(finalState.data).toEqual(client.extract());
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "stores shadow of restore returns the same result as accessing the method directly on the cache",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
          ],
        },
      };

      const link = mockSingleLink({
        request: { query },
        result: { data },
      }).setOnError(reject);

      const initialState: any = {
        data: {
          'ROOT_QUERY.allPeople({"first":"1"}).people.0': {
            name: "Luke Skywalker",
          },
          'ROOT_QUERY.allPeople({"first":1})': {
            people: [
              {
                type: "id",
                generated: true,
                id: 'ROOT_QUERY.allPeople({"first":"1"}).people.0',
              },
            ],
          },
          ROOT_QUERY: {
            'allPeople({"first":1})': {
              type: "id",
              id: 'ROOT_QUERY.allPeople({"first":1})',
              generated: true,
            },
          },
          optimistic: [],
        },
      };

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }).restore(
          initialState.data
        ),
      });

      expect(client.restore(initialState.data)).toEqual(
        client.cache.restore(initialState.data)
      );

      resolve();
    }
  );

  itAsync(
    "should return errors correctly for a single query",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const errors: GraphQLError[] = [
        new GraphQLError(
          "Syntax Error GraphQL request (8:9) Expected Name, found EOF"
        ),
      ];

      const link = mockSingleLink({
        request: { query },
        result: { errors },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      return client
        .query({ query })
        .catch((error: ApolloError) => {
          expect(error.graphQLErrors).toEqual(errors);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should return GraphQL errors correctly for a single query with an apollo-link enabled network interface",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
          ],
        },
      };

      const errors: GraphQLError[] = [
        new GraphQLError(
          "Syntax Error GraphQL request (8:9) Expected Name, found EOF"
        ),
      ];

      const link = ApolloLink.from([
        () => {
          return new Observable((observer) => {
            observer.next({ data, errors });
          });
        },
      ]);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      client.query({ query }).catch((error: ApolloError) => {
        expect(error.graphQLErrors).toEqual(errors);
        resolve();
      });
    }
  );

  itAsync(
    "should pass a network error correctly on a query with apollo-link network interface",
    (resolve, reject) => {
      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const networkError = new Error("Some kind of network error.");

      const link = ApolloLink.from([
        () => {
          return new Observable((_) => {
            throw networkError;
          });
        },
      ]);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      client.query({ query }).catch((error: ApolloError) => {
        expect(error.networkError).toBeDefined();
        expect(error.networkError!.message).toEqual(networkError.message);
        resolve();
      });
    }
  );

  it("should not warn when receiving multiple results from apollo-link network interface", () => {
    const query = gql`
      query people {
        allPeople(first: 1) {
          people {
            name
          }
        }
      }
    `;

    const data = {
      allPeople: {
        people: [
          {
            name: "Luke Skywalker",
          },
        ],
      },
    };

    const link = ApolloLink.from([() => Observable.of({ data }, { data })]);

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    return client.query({ query }).then((result: ExecutionResult) => {
      expect(result.data).toEqual(data);
    });
  });

  itAsync.skip(
    "should surface errors in observer.next as uncaught",
    (resolve, reject) => {
      const expectedError = new Error("this error should not reach the store");
      const listeners = process.listeners("uncaughtException");
      const oldHandler = listeners[listeners.length - 1];
      const handleUncaught = (e: Error) => {
        console.log(e);
        process.removeListener("uncaughtException", handleUncaught);
        if (typeof oldHandler === "function")
          process.addListener("uncaughtException", oldHandler);
        if (e === expectedError) {
          resolve();
        } else {
          reject(e);
        }
      };
      process.removeListener("uncaughtException", oldHandler);
      process.addListener("uncaughtException", handleUncaught);

      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const data = {
        allPeople: {
          people: [
            {
              name: "Luke Skywalker",
            },
          ],
        },
      };

      const link = mockSingleLink({
        request: { query },
        result: { data },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const handle = client.watchQuery({ query });

      handle.subscribe({
        next() {
          throw expectedError;
        },
      });
    }
  );

  itAsync.skip(
    "should surfaces errors in observer.error as uncaught",
    (resolve, reject) => {
      const expectedError = new Error("this error should not reach the store");
      const listeners = process.listeners("uncaughtException");
      const oldHandler = listeners[listeners.length - 1];
      const handleUncaught = (e: Error) => {
        process.removeListener("uncaughtException", handleUncaught);
        process.addListener("uncaughtException", oldHandler);
        if (e === expectedError) {
          resolve();
        } else {
          reject(e);
        }
      };
      process.removeListener("uncaughtException", oldHandler);
      process.addListener("uncaughtException", handleUncaught);

      const query = gql`
        query people {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const link = mockSingleLink({
        request: { query },
        result: {},
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const handle = client.watchQuery({ query });
      handle.subscribe({
        next() {
          reject(new Error("did not expect next to be called"));
        },
        error() {
          throw expectedError;
        },
      });
    }
  );

  itAsync("should allow for subscribing to a request", (resolve, reject) => {
    const query = gql`
      query people {
        allPeople(first: 1) {
          people {
            name
          }
        }
      }
    `;

    const data = {
      allPeople: {
        people: [
          {
            name: "Luke Skywalker",
          },
        ],
      },
    };

    const link = mockSingleLink({
      request: { query },
      result: { data },
    }).setOnError(reject);

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    const handle = client.watchQuery({ query });

    handle.subscribe({
      next(result) {
        expect(result.data).toEqual(data);
        resolve();
      },
    });
  });

  itAsync("should be able to transform queries", (resolve, reject) => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;
    const transformedQuery = gql`
      query {
        author {
          firstName
          lastName
          __typename
        }
      }
    `;

    const result = {
      author: {
        firstName: "John",
        lastName: "Smith",
      },
    };
    const transformedResult = {
      author: {
        firstName: "John",
        lastName: "Smith",
        __typename: "Author",
      },
    };

    const link = mockSingleLink(
      {
        request: { query },
        result: { data: result },
      },
      {
        request: { query: transformedQuery },
        result: { data: transformedResult },
      },
      false
    ).setOnError(reject);

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: true }),
    });

    return client
      .query({ query })
      .then((actualResult) => {
        expect(actualResult.data).toEqual(transformedResult);
      })
      .then(resolve, reject);
  });

  itAsync(
    "should be able to transform queries on network-only fetches",
    (resolve, reject) => {
      const query = gql`
        query {
          author {
            firstName
            lastName
          }
        }
      `;
      const transformedQuery = gql`
        query {
          author {
            firstName
            lastName
            __typename
          }
        }
      `;
      const result = {
        author: {
          firstName: "John",
          lastName: "Smith",
        },
      };
      const transformedResult = {
        author: {
          firstName: "John",
          lastName: "Smith",
          __typename: "Author",
        },
      };
      const link = mockSingleLink(
        {
          request: { query },
          result: { data: result },
        },
        {
          request: { query: transformedQuery },
          result: { data: transformedResult },
        },
        false
      ).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: true }),
      });

      return client
        .query({ fetchPolicy: "network-only", query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(transformedResult);
        })
        .then(resolve, reject);
    }
  );

  it("removes @client fields from the query before it reaches the link", async () => {
    const result: { current: Operation | undefined } = {
      current: undefined,
    };

    const query = gql`
      query {
        author {
          firstName
          lastName
          isInCollection @client
        }
      }
    `;

    const transformedQuery = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;

    const link = new ApolloLink((operation) => {
      result.current = operation;

      return Observable.of({
        data: {
          author: {
            firstName: "John",
            lastName: "Smith",
            __typename: "Author",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    await client.query({ query });

    expect(print(result.current!.query)).toEqual(print(transformedQuery));
  });

  itAsync("should handle named fragments on mutations", (resolve, reject) => {
    const mutation = gql`
      mutation {
        starAuthor(id: 12) {
          author {
            __typename
            ...authorDetails
          }
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    const result = {
      starAuthor: {
        author: {
          __typename: "Author",
          firstName: "John",
          lastName: "Smith",
        },
      },
    };
    const link = mockSingleLink({
      request: { query: mutation },
      result: { data: result },
    }).setOnError(reject);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    return client
      .mutate({ mutation })
      .then((actualResult) => {
        expect(actualResult.data).toEqual(result);
      })
      .then(resolve, reject);
  });

  itAsync(
    "should be able to handle named fragments on network-only queries",
    (resolve, reject) => {
      const query = gql`
        fragment authorDetails on Author {
          firstName
          lastName
        }

        query {
          author {
            __typename
            ...authorDetails
          }
        }
      `;
      const result = {
        author: {
          __typename: "Author",
          firstName: "John",
          lastName: "Smith",
        },
      };

      const link = mockSingleLink({
        request: { query },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      return client
        .query({ fetchPolicy: "network-only", query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should be able to handle named fragments with multiple fragments",
    (resolve, reject) => {
      const query = gql`
        query {
          author {
            __typename
            ...authorDetails
            ...moreDetails
          }
        }

        fragment authorDetails on Author {
          firstName
          lastName
        }

        fragment moreDetails on Author {
          address
        }
      `;
      const result = {
        author: {
          __typename: "Author",
          firstName: "John",
          lastName: "Smith",
          address: "1337 10th St.",
        },
      };

      const link = mockSingleLink({
        request: { query },
        result: { data: result },
      }).setOnError(reject);
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync("should be able to handle named fragments", (resolve, reject) => {
    const query = gql`
      query {
        author {
          __typename
          ...authorDetails
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    const result = {
      author: {
        __typename: "Author",
        firstName: "John",
        lastName: "Smith",
      },
    };

    const link = mockSingleLink({
      request: { query },
      result: { data: result },
    }).setOnError(reject);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    return client
      .query({ query })
      .then((actualResult) => {
        expect(actualResult.data).toEqual(result);
      })
      .then(resolve, reject);
  });

  itAsync(
    "should be able to handle inlined fragments on an Interface type",
    (resolve, reject) => {
      const query = gql`
        query items {
          items {
            ...ItemFragment
            __typename
          }
        }

        fragment ItemFragment on Item {
          id
          __typename
          ... on ColorItem {
            color
            __typename
          }
        }
      `;
      const result = {
        items: [
          {
            __typename: "ColorItem",
            id: "27tlpoPeXm6odAxj3paGQP",
            color: "red",
          },
          {
            __typename: "MonochromeItem",
            id: "1t3iFLsHBm4c4RjOMdMgOO",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query },
        result: { data: result },
      }).setOnError(reject);
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          possibleTypes: {
            Item: ["ColorItem", "MonochromeItem"],
          },
        }),
      });
      return client
        .query({ query })
        .then((actualResult: any) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should be able to handle inlined fragments on an Interface type with introspection fragment matcher",
    (resolve, reject) => {
      const query = gql`
        query items {
          items {
            ...ItemFragment
            __typename
          }
        }

        fragment ItemFragment on Item {
          id
          ... on ColorItem {
            color
            __typename
          }
          __typename
        }
      `;
      const result = {
        items: [
          {
            __typename: "ColorItem",
            id: "27tlpoPeXm6odAxj3paGQP",
            color: "red",
          },
          {
            __typename: "MonochromeItem",
            id: "1t3iFLsHBm4c4RjOMdMgOO",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          possibleTypes: {
            Item: ["ColorItem", "MonochromeItem"],
          },
        }),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should call updateQueries and update after mutation on query with inlined fragments on an Interface type",
    (resolve, reject) => {
      const query = gql`
        query items {
          items {
            ...ItemFragment
            __typename
          }
        }

        fragment ItemFragment on Item {
          id
          ... on ColorItem {
            color
            __typename
          }
          __typename
        }
      `;
      const result = {
        items: [
          {
            __typename: "ColorItem",
            id: "27tlpoPeXm6odAxj3paGQP",
            color: "red",
          },
          {
            __typename: "MonochromeItem",
            id: "1t3iFLsHBm4c4RjOMdMgOO",
          },
        ],
      };

      const mutation = gql`
        mutation myMutationName {
          fortuneCookie
        }
      `;
      const mutationResult = {
        fortuneCookie: "The waiter spit in your food",
      };

      const link = mockSingleLink(
        {
          request: { query },
          result: { data: result },
        },
        {
          request: { query: mutation },
          result: { data: mutationResult },
        }
      ).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          possibleTypes: {
            Item: ["ColorItem", "MonochromeItem"],
          },
        }),
      });

      const queryUpdaterSpy = jest.fn();
      const queryUpdater = (prev: any) => {
        queryUpdaterSpy();
        return prev;
      };
      const updateQueries = {
        items: queryUpdater,
      };

      const updateSpy = jest.fn();

      const obs = client.watchQuery({ query });

      const sub = obs.subscribe({
        next() {
          client
            .mutate({ mutation, updateQueries, update: updateSpy })
            .then(() => {
              expect(queryUpdaterSpy).toBeCalled();
              expect(updateSpy).toBeCalled();
              sub.unsubscribe();
              resolve();
            })
            .catch((err) => {
              reject(err);
            });
        },
        error(err) {
          reject(err);
        },
      });
    }
  );

  it("should send operationName along with the query to the server", () => {
    const query = gql`
      query myQueryName {
        fortuneCookie
      }
    `;
    const data = {
      fortuneCookie: "The waiter spit in your food",
    };
    const link = ApolloLink.from([
      (request) => {
        expect(request.operationName).toBe("myQueryName");
        return Observable.of({ data });
      },
    ]);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    return client.query({ query }).then((actualResult) => {
      expect(actualResult.data).toEqual(data);
    });
  });

  it("should send operationName along with the mutation to the server", () => {
    const mutation = gql`
      mutation myMutationName {
        fortuneCookie
      }
    `;
    const data = {
      fortuneCookie: "The waiter spit in your food",
    };
    const link = ApolloLink.from([
      (request) => {
        expect(request.operationName).toBe("myMutationName");
        return Observable.of({ data });
      },
    ]);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    return client.mutate({ mutation }).then((actualResult) => {
      expect(actualResult.data).toEqual(data);
    });
  });

  itAsync(
    "does not deduplicate queries if option is set to false",
    (resolve, reject) => {
      const queryDoc = gql`
        query {
          author {
            name
          }
        }
      `;
      const data = {
        author: {
          name: "Jonas",
        },
      };
      const data2 = {
        author: {
          name: "Dhaivat",
        },
      };

      // we have two responses for identical queries, and both should be requested.
      // the second one should make it through to the network interface.
      const link = mockSingleLink(
        {
          request: { query: queryDoc },
          result: { data },
          delay: 10,
        },
        {
          request: { query: queryDoc },
          result: { data: data2 },
        }
      ).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
        queryDeduplication: false,
      });

      const q1 = client.query({ query: queryDoc });
      const q2 = client.query({ query: queryDoc });

      // if deduplication happened, result2.data will equal data.
      return Promise.all([q1, q2])
        .then(([result1, result2]) => {
          expect(result1.data).toEqual(data);
          expect(result2.data).toEqual(data2);
        })
        .then(resolve, reject);
    }
  );

  itAsync("deduplicates queries by default", (resolve, reject) => {
    const queryDoc = gql`
      query {
        author {
          name
        }
      }
    `;
    const data = {
      author: {
        name: "Jonas",
      },
    };
    const data2 = {
      author: {
        name: "Dhaivat",
      },
    };

    // we have two responses for identical queries, but only the first should be requested.
    // the second one should never make it through to the network interface.
    const link = mockSingleLink(
      {
        request: { query: queryDoc },
        result: { data },
        delay: 10,
      },
      {
        request: { query: queryDoc },
        result: { data: data2 },
      }
    ).setOnError(reject);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    const q1 = client.query({ query: queryDoc });
    const q2 = client.query({ query: queryDoc });

    // if deduplication didn't happen, result.data will equal data2.
    return Promise.all([q1, q2])
      .then(([result1, result2]) => {
        expect(result1.data).toEqual(result2.data);
      })
      .then(resolve, reject);
  });

  it("deduplicates queries if query context.queryDeduplication is set to true", () => {
    const queryDoc = gql`
      query {
        author {
          name
        }
      }
    `;
    const data = {
      author: {
        name: "Jonas",
      },
    };
    const data2 = {
      author: {
        name: "Dhaivat",
      },
    };

    // we have two responses for identical queries, but only the first should be requested.
    // the second one should never make it through to the network interface.
    const link = mockSingleLink(
      {
        request: { query: queryDoc },
        result: { data },
        delay: 10,
      },
      {
        request: { query: queryDoc },
        result: { data: data2 },
      }
    );
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
      queryDeduplication: false,
    });

    // Both queries need to be deduplicated, otherwise only one gets tracked
    const q1 = client.query({
      query: queryDoc,
      context: { queryDeduplication: true },
    });
    const q2 = client.query({
      query: queryDoc,
      context: { queryDeduplication: true },
    });

    // if deduplication happened, result2.data will equal data.
    return Promise.all([q1, q2]).then(([result1, result2]) => {
      expect(result1.data).toEqual(data);
      expect(result2.data).toEqual(data);
    });
  });

  it("does not deduplicate queries if query context.queryDeduplication is set to false", () => {
    const queryDoc = gql`
      query {
        author {
          name
        }
      }
    `;
    const data = {
      author: {
        name: "Jonas",
      },
    };
    const data2 = {
      author: {
        name: "Dhaivat",
      },
    };

    // we have two responses for identical queries, and both should be requested.
    // the second one should make it through to the network interface.
    const link = mockSingleLink(
      {
        request: { query: queryDoc },
        result: { data },
        delay: 10,
      },
      {
        request: { query: queryDoc },
        result: { data: data2 },
      }
    );
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({ addTypename: false }),
    });

    // The first query gets tracked in the dedup logic, the second one ignores it and runs anyways
    const q1 = client.query({ query: queryDoc });
    const q2 = client.query({
      query: queryDoc,
      context: { queryDeduplication: false },
    });

    // if deduplication happened, result2.data will equal data.
    return Promise.all([q1, q2]).then(([result1, result2]) => {
      expect(result1.data).toEqual(data);
      expect(result2.data).toEqual(data2);
    });
  });

  itAsync(
    "unsubscribes from deduplicated observables only once",
    (resolve, reject) => {
      const document: DocumentNode = gql`
        query test1($x: String) {
          test(x: $x)
        }
      `;

      const variables1 = { x: "Hello World" };
      const variables2 = { x: "Hello World" };

      let unsubscribed = false;

      const client = new ApolloClient({
        link: new ApolloLink(() => {
          return new Observable((observer) => {
            observer.complete();
            return () => {
              unsubscribed = true;
              setTimeout(resolve, 0);
            };
          });
        }),
        cache: new InMemoryCache(),
      });

      const sub1 = client
        .watchQuery({
          query: document,
          variables: variables1,
        })
        .subscribe({});

      const sub2 = client
        .watchQuery({
          query: document,
          variables: variables2,
        })
        .subscribe({});

      sub1.unsubscribe();
      expect(unsubscribed).toBe(false);

      sub2.unsubscribe();
    }
  );

  describe("deprecated options", () => {
    const query = gql`
      query people {
        name
      }
    `;

    it("errors when returnPartialData is used on query", () => {
      const client = new ApolloClient({
        link: ApolloLink.empty(),
        cache: new InMemoryCache(),
      });
      expect(() => {
        client.query({ query, returnPartialData: true } as QueryOptions);
      }).toThrowError(/returnPartialData/);
    });

    it("errors when returnPartialData is used on watchQuery", () => {
      const client = new ApolloClient({
        link: ApolloLink.empty(),
        cache: new InMemoryCache(),
      });
      expect(() => {
        client.query({ query, returnPartialData: true } as QueryOptions);
      }).toThrowError(/returnPartialData/);
    });
  });

  describe("accepts dataIdFromObject option", () => {
    const query = gql`
      query people {
        allPeople(first: 1) {
          people {
            id
            name
          }
        }
      }
    `;

    const data = {
      allPeople: {
        people: [
          {
            id: "1",
            name: "Luke Skywalker",
          },
        ],
      },
    };

    itAsync("for internal store", (resolve, reject) => {
      const link = mockSingleLink({
        request: { query },
        result: { data },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,

        cache: new InMemoryCache({
          dataIdFromObject: (obj: { id: any }) => obj.id,
          addTypename: false,
        }),
      });

      return client
        .query({ query })
        .then((result) => {
          expect(result.data).toEqual(data);
          expect((client.cache as InMemoryCache).extract()["1"]).toEqual({
            id: "1",
            name: "Luke Skywalker",
          });
        })
        .then(resolve, reject);
    });
  });

  describe("cache-and-network fetchPolicy", () => {
    const query = gql`
      query number {
        myNumber {
          n
        }
      }
    `;

    const initialData = {
      myNumber: {
        n: 1,
      },
    };
    const networkFetch = {
      myNumber: {
        n: 2,
      },
    };

    const cacheAndNetworkError =
      "The cache-and-network fetchPolicy does not work with client.query, because " +
      "client.query can only return a single result. Please use client.watchQuery " +
      "to receive multiple results from the cache and the network, or consider " +
      "using a different fetchPolicy, such as cache-first or network-only.";

    function checkCacheAndNetworkError(callback: () => any) {
      try {
        callback();
        throw new Error("not reached");
      } catch (thrown) {
        expect(thrown.message).toBe(cacheAndNetworkError);
      }
    }

    // Test that cache-and-network can only be used on watchQuery, not query.
    it("warns when used with client.query", () => {
      const client = new ApolloClient({
        link: ApolloLink.empty(),
        cache: new InMemoryCache(),
      });

      checkCacheAndNetworkError(() =>
        client.query({
          query,
          fetchPolicy: "cache-and-network" as FetchPolicy,
        })
      );
    });

    it("warns when used with client.query with defaultOptions", () => {
      const client = new ApolloClient({
        link: ApolloLink.empty(),
        cache: new InMemoryCache(),
        defaultOptions: {
          query: {
            fetchPolicy: "cache-and-network" as FetchPolicy,
          },
        },
      });

      checkCacheAndNetworkError(() =>
        client.query({
          query,
          // This undefined value should be ignored in favor of
          // defaultOptions.query.fetchPolicy.
          fetchPolicy: void 0,
        })
      );
    });

    itAsync("fetches from cache first, then network", (resolve, reject) => {
      const link = mockSingleLink({
        request: { query },
        result: { data: networkFetch },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      client.writeQuery({ query, data: initialData });

      const obs = client.watchQuery({
        query,
        fetchPolicy: "cache-and-network",
      });

      subscribeAndCount(reject, obs, (handleCount, result) => {
        if (handleCount === 1) {
          expect(result.data).toEqual(initialData);
        } else if (handleCount === 2) {
          expect(result.data).toEqual(networkFetch);
          resolve();
        }
      });
    });

    itAsync(
      "does not fail if cache entry is not present",
      (resolve, reject) => {
        const link = mockSingleLink({
          request: { query },
          result: { data: networkFetch },
        }).setOnError(reject);
        const client = new ApolloClient({
          link,
          cache: new InMemoryCache({ addTypename: false }),
        });

        const obs = client.watchQuery({
          query,
          fetchPolicy: "cache-and-network",
        });

        subscribeAndCount(reject, obs, (handleCount, result) => {
          expect(handleCount).toBe(1);
          expect(result.data).toEqual(networkFetch);
          expect(result.loading).toBe(false);
          resolve();
        });
      }
    );

    itAsync("fails if network request fails", (resolve, reject) => {
      const link = mockSingleLink(); // no queries = no replies.
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const obs = client.watchQuery({
        query,
        fetchPolicy: "cache-and-network",
      });

      obs.subscribe({
        error: (e) => {
          if (!/No more mocked responses/.test(e.message)) {
            reject(e);
          } else {
            resolve();
          }
        },
      });
    });

    itAsync(
      "fetches from cache first, then network and does not have an unhandled error",
      (resolve, reject) => {
        const link = mockSingleLink({
          request: { query },
          result: { errors: [{ message: "network failure" }] },
        }).setOnError(reject);

        const client = new ApolloClient({
          link,
          cache: new InMemoryCache({ addTypename: false }),
        });

        client.writeQuery({ query, data: initialData });

        const obs = client.watchQuery({
          query,
          fetchPolicy: "cache-and-network",
        });
        let shouldFail = true;
        process.once("unhandledRejection", (rejection) => {
          if (shouldFail) reject("promise had an unhandledRejection");
        });
        let count = 0;
        obs.subscribe({
          next: (result) => {
            expect(result.data).toEqual(initialData);
            expect(result.loading).toBe(true);
            count++;
          },
          error: (e) => {
            expect(e.message).toMatch(/network failure/);
            expect(count).toBe(1); // make sure next was called.
            setTimeout(() => {
              shouldFail = false;
              resolve();
            }, 0);
          },
        });
      }
    );
  });

  describe("standby queries", () => {
    itAsync(
      "are not watching the store or notifying on updates",
      (resolve, reject) => {
        const query = gql`
          {
            test
          }
        `;
        const data = { test: "ok" };
        const data2 = { test: "not ok" };

        const link = mockSingleLink({
          request: { query },
          result: { data },
        }).setOnError(reject);

        const client = new ApolloClient({ link, cache: new InMemoryCache() });

        const obs = client.watchQuery({ query, fetchPolicy: "cache-first" });

        let handleCalled = false;
        subscribeAndCount(reject, obs, (handleCount, result) => {
          if (handleCount === 1) {
            expect(result.data).toEqual(data);
            obs.setOptions({ query, fetchPolicy: "standby" }).then(() => {
              client.writeQuery({ query, data: data2 });
              // this write should be completely ignored by the standby query
            });
            setTimeout(() => {
              if (!handleCalled) {
                resolve();
              }
            }, 20);
          }
          if (handleCount === 2) {
            handleCalled = true;
            reject(new Error("Handle should never be called on standby query"));
          }
        });
      }
    );

    itAsync(
      "return the current result when coming out of standby",
      (resolve, reject) => {
        const query = gql`
          {
            test
          }
        `;
        const data = { test: "ok" };
        const data2 = { test: "not ok" };

        const link = mockSingleLink({
          request: { query },
          result: { data },
        }).setOnError(reject);

        const client = new ApolloClient({ link, cache: new InMemoryCache() });

        const obs = client.watchQuery({ query, fetchPolicy: "cache-first" });

        subscribeAndCount(reject, obs, (handleCount, result) => {
          if (handleCount === 1) {
            expect(result.data).toEqual(data);
            obs.setOptions({ query, fetchPolicy: "standby" }).then(() => {
              client.writeQuery({ query, data: data2 });
              // this write should be completely ignored by the standby query
              setTimeout(() => {
                obs.setOptions({ query, fetchPolicy: "cache-first" });
              }, 10);
            });
          }
          if (handleCount === 2) {
            expect(result.data).toEqual(data2);
            resolve();
          }
        });
      }
    );
  });

  describe("network-only fetchPolicy", () => {
    const query = gql`
      query number {
        myNumber {
          n
        }
      }
    `;

    const firstFetch = {
      myNumber: {
        n: 1,
      },
    };
    const secondFetch = {
      myNumber: {
        n: 2,
      },
    };

    function makeLink(reject: (reason: any) => any) {
      return mockSingleLink(
        {
          request: { query },
          result: { data: firstFetch },
        },
        {
          request: { query },
          result: { data: secondFetch },
        }
      ).setOnError(reject);
    }

    itAsync("forces the query to rerun", (resolve, reject) => {
      const client = new ApolloClient({
        link: makeLink(reject),
        cache: new InMemoryCache({ addTypename: false }),
      });

      // Run a query first to initialize the store
      return (
        client
          .query({ query })
          // then query for real
          .then(() => client.query({ query, fetchPolicy: "network-only" }))
          .then((result) => {
            expect(result.data).toEqual({ myNumber: { n: 2 } });
          })
          .then(resolve, reject)
      );
    });

    itAsync("can be disabled with ssrMode", (resolve, reject) => {
      const client = new ApolloClient({
        link: makeLink(reject),
        ssrMode: true,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const options: QueryOptions = { query, fetchPolicy: "network-only" };

      // Run a query first to initialize the store
      return (
        client
          .query({ query })
          // then query for real
          .then(() => client.query(options))
          .then((result) => {
            expect(result.data).toEqual({ myNumber: { n: 1 } });
            // Test that options weren't mutated, issue #339
            expect(options).toEqual({
              query,
              fetchPolicy: "network-only",
            });
          })
          .then(resolve, reject)
      );
    });

    itAsync(
      "can temporarily be disabled with ssrForceFetchDelay",
      (resolve, reject) => {
        const client = new ApolloClient({
          link: makeLink(reject),
          ssrForceFetchDelay: 100,
          cache: new InMemoryCache({ addTypename: false }),
        });

        // Run a query first to initialize the store
        return (
          client
            .query({ query })
            // then query for real
            .then(() => {
              return client.query({ query, fetchPolicy: "network-only" });
            })
            .then(async (result) => {
              expect(result.data).toEqual({ myNumber: { n: 1 } });
              await new Promise((resolve) => setTimeout(resolve, 100));
              return client.query({ query, fetchPolicy: "network-only" });
            })
            .then((result) => {
              expect(result.data).toEqual({ myNumber: { n: 2 } });
            })
            .then(resolve, reject)
        );
      }
    );
  });

  itAsync(
    "should pass a network error correctly on a mutation",
    (resolve, reject) => {
      const mutation = gql`
        mutation {
          person {
            firstName
            lastName
          }
        }
      `;
      const data = {
        person: {
          firstName: "John",
          lastName: "Smith",
        },
      };
      const networkError = new Error("Some kind of network error.");
      const client = new ApolloClient({
        link: mockSingleLink({
          request: { query: mutation },
          result: { data },
          error: networkError,
        }),
        cache: new InMemoryCache({ addTypename: false }),
      });

      client
        .mutate({ mutation })
        .then((_) => {
          reject(new Error("Returned a result when it should not have."));
        })
        .catch((error: ApolloError) => {
          expect(error.networkError).toBeDefined();
          expect(error.networkError!.message).toBe(networkError.message);
          resolve();
        });
    }
  );

  itAsync(
    "should pass a GraphQL error correctly on a mutation",
    (resolve, reject) => {
      const mutation = gql`
        mutation {
          newPerson {
            person {
              firstName
              lastName
            }
          }
        }
      `;
      const data = {
        person: {
          firstName: "John",
          lastName: "Smith",
        },
      };
      const errors = [new Error("Some kind of GraphQL error.")];
      const client = new ApolloClient({
        link: mockSingleLink({
          request: { query: mutation },
          result: { data, errors },
        }).setOnError(reject),
        cache: new InMemoryCache({ addTypename: false }),
      });
      client
        .mutate({ mutation })
        .then((_) => {
          reject(new Error("Returned a result when it should not have."));
        })
        .catch((error: ApolloError) => {
          expect(error.graphQLErrors).toBeDefined();
          expect(error.graphQLErrors.length).toBe(1);
          expect(error.graphQLErrors[0].message).toBe(errors[0].message);
          resolve();
        });
    }
  );

  itAsync(
    "should allow errors to be returned from a mutation",
    (resolve, reject) => {
      const mutation = gql`
        mutation {
          newPerson {
            person {
              firstName
              lastName
            }
          }
        }
      `;
      const data = {
        person: {
          firstName: "John",
          lastName: "Smith",
        },
      };
      const errors = [new Error("Some kind of GraphQL error.")];
      const client = new ApolloClient({
        link: mockSingleLink({
          request: { query: mutation },
          result: {
            errors,
            data: {
              newPerson: data,
            },
          },
        }).setOnError(reject),
        cache: new InMemoryCache({ addTypename: false }),
      });
      client
        .mutate({ mutation, errorPolicy: "all" })
        .then((result) => {
          expect(result.errors).toBeDefined();
          expect(result.errors!.length).toBe(1);
          expect(result.errors![0].message).toBe(errors[0].message);
          expect(result.data).toEqual({
            newPerson: data,
          });
          resolve();
        })
        .catch((error: ApolloError) => {
          throw error;
        });
    }
  );

  itAsync("should strip errors on a mutation if ignored", (resolve, reject) => {
    const mutation = gql`
      mutation {
        newPerson {
          person {
            firstName
            lastName
          }
        }
      }
    `;
    const data = {
      newPerson: {
        person: {
          firstName: "John",
          lastName: "Smith",
        },
      },
    };
    const errors = [new Error("Some kind of GraphQL error.")];
    const client = new ApolloClient({
      link: mockSingleLink({
        request: { query: mutation },
        result: { data, errors },
      }).setOnError(reject),
      cache: new InMemoryCache({ addTypename: false }),
    });
    client
      .mutate({ mutation, errorPolicy: "ignore" })
      .then((result) => {
        expect(result.errors).toBeUndefined();
        expect(result.data).toEqual(data);
        resolve();
      })
      .catch((error: ApolloError) => {
        throw error;
      });
  });

  itAsync(
    "should rollback optimistic after mutation got a GraphQL error",
    (resolve, reject) => {
      const mutation = gql`
        mutation {
          newPerson {
            person {
              firstName
              lastName
            }
          }
        }
      `;
      const data = {
        newPerson: {
          person: {
            firstName: "John",
            lastName: "Smith",
          },
        },
      };
      const errors = [new Error("Some kind of GraphQL error.")];
      const client = new ApolloClient({
        link: mockSingleLink({
          request: { query: mutation },
          result: { data, errors },
        }).setOnError(reject),
        cache: new InMemoryCache({ addTypename: false }),
      });
      const mutatePromise = client.mutate({
        mutation,
        optimisticResponse: {
          newPerson: {
            person: {
              firstName: "John*",
              lastName: "Smith*",
            },
          },
        },
      });

      {
        const { data, optimisticData } = client.cache as any;
        expect(optimisticData).not.toBe(data);
        expect(optimisticData.parent).toBe(data.stump);
        expect(optimisticData.parent.parent).toBe(data);
      }

      mutatePromise
        .then((_) => {
          reject(new Error("Returned a result when it should not have."));
        })
        .catch((_: ApolloError) => {
          const { data, optimisticData } = client.cache as any;
          expect(optimisticData).toBe(data.stump);
          resolve();
        });
    }
  );

  it("has a clearStore method which calls QueryManager", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    // @ts-ignore
    const spy = jest.spyOn(client.queryManager, "clearStore");
    await client.clearStore();
    expect(spy).toHaveBeenCalled();
  });

  it("has an onClearStore method which takes a callback to be called after clearStore", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    const onClearStore = jest.fn();
    client.onClearStore(onClearStore);

    await client.clearStore();

    expect(onClearStore).toHaveBeenCalled();
  });

  it("onClearStore returns a method that unsubscribes the callback", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    const onClearStore = jest.fn();
    const unsubscribe = client.onClearStore(onClearStore);

    unsubscribe();

    await client.clearStore();
    expect(onClearStore).not.toHaveBeenCalled();
  });

  it("has a resetStore method which calls QueryManager", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    // @ts-ignore
    const spy = jest.spyOn(client.queryManager, "clearStore");
    await client.resetStore();
    expect(spy).toHaveBeenCalled();
  });

  it("has an onResetStore method which takes a callback to be called after resetStore", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    const onResetStore = jest.fn();
    client.onResetStore(onResetStore);

    await client.resetStore();

    expect(onResetStore).toHaveBeenCalled();
  });

  it("onResetStore returns a method that unsubscribes the callback", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    const onResetStore = jest.fn();
    const unsubscribe = client.onResetStore(onResetStore);

    unsubscribe();

    await client.resetStore();
    expect(onResetStore).not.toHaveBeenCalled();
  });

  it("resetStore waits until all onResetStore callbacks are called", async () => {
    const delay = (time: number) => new Promise((r) => setTimeout(r, time));

    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    let count = 0;
    const onResetStoreOne = jest.fn(async () => {
      expect(count).toEqual(0);
      await delay(10).then(() => count++);
      expect(count).toEqual(1);
    });

    const onResetStoreTwo = jest.fn(async () => {
      expect(count).toEqual(0);
      await delay(11).then(() => count++);
      expect(count).toEqual(2);
    });

    client.onResetStore(onResetStoreOne);
    client.onResetStore(onResetStoreTwo);

    expect(count).toEqual(0);
    await client.resetStore();
    expect(count).toEqual(2);
  });

  itAsync(
    "invokes onResetStore callbacks before notifying queries during resetStore call",
    async (resolve, reject) => {
      const delay = (time: number) => new Promise((r) => setTimeout(r, time));

      const query = gql`
        query {
          author {
            firstName
            lastName
          }
        }
      `;

      const data = {
        author: {
          __typename: "Author",
          firstName: "John",
          lastName: "Smith",
        },
      };

      const data2 = {
        author: {
          __typename: "Author",
          firstName: "Joe",
          lastName: "Joe",
        },
      };

      const link = ApolloLink.from([
        new ApolloLink(
          () =>
            new Observable((observer) => {
              observer.next({ data });
              observer.complete();
              return;
            })
        ),
      ]);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache(),
      });

      let count = 0;
      const onResetStoreOne = jest.fn(async () => {
        expect(count).toEqual(0);
        await delay(10).then(() => count++);
        expect(count).toEqual(1);
      });

      const onResetStoreTwo = jest.fn(async () => {
        expect(count).toEqual(0);
        await delay(11).then(() => count++);
        expect(count).toEqual(2);
        expect(client.readQuery({ query })).toBe(null);
        client.cache.writeQuery({ query, data: data2 });
      });

      client.onResetStore(onResetStoreOne);
      client.onResetStore(onResetStoreTwo);

      let called = false;
      const next = jest.fn((d) => {
        if (called) {
          expect(onResetStoreOne).toHaveBeenCalled();
        } else {
          expect(d.data).toEqual(data);
          called = true;
        }
      });

      client
        .watchQuery<any>({
          query,
          notifyOnNetworkStatusChange: false,
        })
        .subscribe({
          next,
          error: reject,
          complete: reject,
        });

      expect(count).toEqual(0);
      await client.resetStore();
      expect(count).toEqual(2);
      //watchQuery should only receive data twice
      expect(next).toHaveBeenCalledTimes(2);

      resolve();
    }
  );

  it("has a reFetchObservableQueries method which calls QueryManager", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    // @ts-ignore
    const spy = jest.spyOn(client.queryManager, "reFetchObservableQueries");
    await client.reFetchObservableQueries();
    expect(spy).toHaveBeenCalled();
  });

  it("has a refetchQueries method which calls QueryManager", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    const spy = jest.spyOn(client["queryManager"], "refetchQueries");
    spy.mockImplementation(() => new Map());

    const options = { include: ["Author1"] };
    await client.refetchQueries(options);

    expect(spy).toHaveBeenCalledWith(options);
    spy.mockRestore();
  });

  it("has a getObservableQueries method which calls QueryManager", async () => {
    const client = new ApolloClient({
      link: ApolloLink.empty(),
      cache: new InMemoryCache(),
    });

    // @ts-ignore
    const spy = jest.spyOn(client.queryManager, "getObservableQueries");
    await client.getObservableQueries();
    expect(spy).toHaveBeenCalled();
  });

  itAsync(
    "should propagate errors from network interface to observers",
    (resolve, reject) => {
      const link = ApolloLink.from([
        () =>
          new Observable((x) => {
            x.error(new Error("Uh oh!"));
            return;
          }),
      ]);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      const handle = client.watchQuery({
        query: gql`
          query {
            a
            b
            c
          }
        `,
      });

      handle.subscribe({
        error(error) {
          expect(error.message).toBe("Uh oh!");
          resolve();
        },
      });
    }
  );

  itAsync(
    "should be able to refetch after there was a network error",
    (resolve, reject) => {
      const query: DocumentNode = gql`
        query somethingelse {
          allPeople(first: 1) {
            people {
              name
            }
          }
        }
      `;

      const data = { allPeople: { people: [{ name: "Luke Skywalker" }] } };
      const dataTwo = { allPeople: { people: [{ name: "Princess Leia" }] } };
      const link = mockSingleLink(
        { request: { query }, result: { data } },
        { request: { query }, error: new Error("This is an error!") },
        { request: { query }, result: { data: dataTwo } }
      );
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
      });

      let count = 0;
      const noop = () => null;

      const observable = client.watchQuery({
        query,
        notifyOnNetworkStatusChange: true,
      });

      let subscription: any = null;

      const observerOptions = {
        next(result: any) {
          try {
            switch (count++) {
              case 0:
                if (!result.data!.allPeople) {
                  reject("Should have data by this point");
                  break;
                }
                // First result is loaded, run a refetch to get the second result
                // which is an error.
                expect(result.loading).toBeFalsy();
                expect(result.networkStatus).toBe(7);
                expect(result.data!.allPeople).toEqual(data.allPeople);
                setTimeout(() => {
                  observable.refetch().then(() => {
                    reject("Expected error value on first refetch.");
                  }, noop);
                }, 0);
                break;
              case 1:
                // Waiting for the second result to load
                expect(result.loading).toBeTruthy();
                expect(result.networkStatus).toBe(4);
                break;
              // case 2 is handled by the error callback
              case 3:
                expect(result.loading).toBeTruthy();
                expect(result.networkStatus).toBe(4);
                expect(result.errors).toBeFalsy();
                break;
              case 4:
                // Third result's data is loaded
                expect(result.loading).toBeFalsy();
                expect(result.networkStatus).toBe(7);
                expect(result.errors).toBeFalsy();
                if (!result.data) {
                  reject("Should have data by this point");
                  break;
                }
                expect(result.data.allPeople).toEqual(dataTwo.allPeople);
                resolve();
                break;
              default:
                throw new Error("Unexpected fall through");
            }
          } catch (e) {
            reject(e);
          }
        },
        error(error: Error) {
          expect(count++).toBe(2);
          expect(error.message).toBe("This is an error!");

          subscription.unsubscribe();

          const lastError = observable.getLastError();
          expect(lastError).toBeInstanceOf(ApolloError);
          expect(lastError!.networkError).toEqual(error);

          const lastResult = observable.getLastResult();
          expect(lastResult).toBeTruthy();
          expect(lastResult!.loading).toBe(false);
          expect(lastResult!.networkStatus).toBe(8);

          observable.resetLastResults();
          subscription = observable.subscribe(observerOptions);

          // The error arrived, run a refetch to get the third result
          // which should now contain valid data.
          setTimeout(() => {
            observable.refetch().catch(() => {
              reject("Expected good data on second refetch.");
            });
          }, 0);
        },
      };

      subscription = observable.subscribe(observerOptions);
    }
  );

  itAsync("should throw a GraphQL error", (resolve, reject) => {
    const query = gql`
      query {
        posts {
          foo
          __typename
        }
      }
    `;
    const errors: GraphQLError[] = [
      new GraphQLError('Cannot query field "foo" on type "Post".'),
    ];
    const link = mockSingleLink({
      request: { query },
      result: { errors },
    }).setOnError(reject);
    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    return client
      .query({ query })
      .catch((err) => {
        expect(err.message).toBe('Cannot query field "foo" on type "Post".');
      })
      .then(resolve, reject);
  });

  withErrorSpy(
    itAsync,
    "should warn if server returns wrong data",
    (resolve, reject) => {
      const query = gql`
        query {
          todos {
            id
            name
            description
            __typename
          }
        }
      `;
      const result = {
        data: {
          todos: [
            {
              id: "1",
              name: "Todo 1",
              price: 100,
              __typename: "Todo",
            },
          ],
        },
      };

      const link = mockSingleLink({
        request: { query },
        result,
      }).setOnError(reject);
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          // Passing an empty map enables the warning:
          possibleTypes: {},
        }),
      });

      return client
        .query({ query })
        .then(({ data }) => {
          const { price, ...todoWithoutPrice } = data.todos[0];
          expect(data).toEqual({
            todos: [
              todoWithoutPrice,
            ],
          });
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "runs a query with the connection directive and writes it to the store key defined in the directive",
    (resolve, reject) => {
      const query = gql`
        {
          books(skip: 0, limit: 2) @connection(key: "abc") {
            name
          }
        }
      `;

      const transformedQuery = gql`
        {
          books(skip: 0, limit: 2) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query: transformedQuery },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache(),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "runs query with cache field policy analogous to @connection",
    (resolve, reject) => {
      const query = gql`
        {
          books(skip: 0, limit: 2) {
            name
          }
        }
      `;

      const transformedQuery = gql`
        {
          books(skip: 0, limit: 2) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query: transformedQuery },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          typePolicies: {
            Query: {
              fields: {
                books: {
                  keyArgs: () => "abc",
                },
              },
            },
          },
        }),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should remove the connection directive before the link is sent",
    (resolve, reject) => {
      const query = gql`
        {
          books(skip: 0, limit: 2) @connection(key: "books") {
            name
          }
        }
      `;

      const transformedQuery = gql`
        {
          books(skip: 0, limit: 2) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query: transformedQuery },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache(),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
        })
        .then(resolve, reject);
    }
  );
});

describe("@connection", () => {
  itAsync(
    "should run a query with the @connection directive and write the result to the store key defined in the directive",
    (resolve, reject) => {
      const query = gql`
        {
          books(skip: 0, limit: 2) @connection(key: "abc") {
            name
          }
        }
      `;

      const transformedQuery = gql`
        {
          books(skip: 0, limit: 2) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const link = mockSingleLink({
        request: { query: transformedQuery },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache(),
      });

      return client
        .query({ query })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
          expect((client.cache as InMemoryCache).extract()).toMatchSnapshot();
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should run a query with the connection directive and filter arguments and write the result to the correct store key",
    (resolve, reject) => {
      const query = gql`
        query books($order: string) {
          books(skip: 0, limit: 2, order: $order)
            @connection(key: "abc", filter: ["order"]) {
            name
          }
        }
      `;
      const transformedQuery = gql`
        query books($order: string) {
          books(skip: 0, limit: 2, order: $order) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const variables = { order: "popularity" };

      const link = mockSingleLink({
        request: { query: transformedQuery, variables },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache(),
      });

      return client
        .query({ query, variables })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
          expect((client.cache as InMemoryCache).extract()).toMatchSnapshot();
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should support cache field policies that filter key arguments",
    (resolve, reject) => {
      const query = gql`
        query books($order: string) {
          books(skip: 0, limit: 2, order: $order) {
            name
          }
        }
      `;
      const transformedQuery = gql`
        query books($order: string) {
          books(skip: 0, limit: 2, order: $order) {
            name
            __typename
          }
        }
      `;

      const result = {
        books: [
          {
            name: "abcd",
            __typename: "Book",
          },
        ],
      };

      const variables = { order: "popularity" };

      const link = mockSingleLink({
        request: { query: transformedQuery, variables },
        result: { data: result },
      }).setOnError(reject);

      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({
          typePolicies: {
            Query: {
              fields: {
                books: {
                  keyArgs: ["order"],
                },
              },
            },
          },
        }),
      });

      return client
        .query({ query, variables })
        .then((actualResult) => {
          expect(actualResult.data).toEqual(result);
          expect((client.cache as InMemoryCache).extract()).toMatchSnapshot();
        })
        .then(resolve, reject);
    }
  );

  itAsync(
    "should broadcast changes for reactive variables",
    async (resolve, reject) => {
      const aVar = makeVar(123);
      const bVar = makeVar("asdf");
      const cache: InMemoryCache = new InMemoryCache({
        typePolicies: {
          Query: {
            fields: {
              a() {
                return aVar();
              },
              b() {
                return bVar();
              },
            },
          },
        },
      });

      const client = new ApolloClient({ cache });

      const obsQueries = new Set<ObservableQuery<any>>();
      const subs = new Set<ObservableSubscription>();
      function watch(
        query: DocumentNode,
        fetchPolicy: WatchQueryFetchPolicy = "cache-first"
      ): any[] {
        const results: any[] = [];
        const obsQuery = client.watchQuery({
          query,
          fetchPolicy,
        });
        obsQueries.add(obsQuery);
        subs.add(
          obsQuery.subscribe({
            next(result) {
              results.push(result.data);
            },
          })
        );
        return results;
      }

      const aResults = watch(gql`
        {
          a
        }
      `);
      const bResults = watch(gql`
        {
          b
        }
      `);
      const abResults = watch(gql`
        {
          a
          b
        }
      `);

      await wait();

      function checkLastResult(
        results: any[],
        expectedData: Record<string, any>
      ) {
        const lastResult = results[results.length - 1];
        expect(lastResult).toEqual(expectedData);
        return lastResult;
      }

      checkLastResult(aResults, { a: 123 });
      const bAsdf = checkLastResult(bResults, { b: "asdf" });
      checkLastResult(abResults, { a: 123, b: "asdf" });

      aVar(aVar() + 111);
      await wait();

      const a234 = checkLastResult(aResults, { a: 234 });
      expect(checkLastResult(bResults, { b: "asdf" })).toBe(bAsdf);
      checkLastResult(abResults, { a: 234, b: "asdf" });

      bVar(bVar().toUpperCase());
      await wait();

      expect(checkLastResult(aResults, { a: 234 })).toBe(a234);
      checkLastResult(bResults, { b: "ASDF" });
      checkLastResult(abResults, { a: 234, b: "ASDF" });

      aVar(aVar() + 222);
      bVar("oyez");
      await wait();

      const a456 = checkLastResult(aResults, { a: 456 });
      const bOyez = checkLastResult(bResults, { b: "oyez" });
      const a456bOyez = checkLastResult(abResults, { a: 456, b: "oyez" });

      // Since the ObservableQuery skips results that are the same as the
      // previous result, and nothing is actually changing about the
      // ROOT_QUERY.a field, clear previous results to give the invalidated
      // results a chance to be delivered.
      obsQueries.forEach((obsQuery) => obsQuery.resetLastResults());
      await wait();
      // Verify that resetting previous results did not trigger the delivery
      // of any new results, by itself.
      expect(checkLastResult(aResults, a456)).toBe(a456);
      expect(checkLastResult(bResults, bOyez)).toBe(bOyez);
      expect(checkLastResult(abResults, a456bOyez)).toBe(a456bOyez);

      // Now invalidate the ROOT_QUERY.a field.
      client.cache.evict({ fieldName: "a" });
      await wait();

      expect(checkLastResult(aResults, a456)).toBe(a456);
      expect(checkLastResult(bResults, bOyez)).toBe(bOyez);
      expect(checkLastResult(abResults, a456bOyez)).toBe(a456bOyez);

      const cQuery = gql`
        {
          c
        }
      `;
      // Passing cache-only as the fetchPolicy allows the { c: "see" }
      // result to be delivered even though networkStatus is still loading.
      const cResults = watch(cQuery, "cache-only");

      // Now try writing directly to the cache, rather than calling
      // client.writeQuery.
      client.cache.writeQuery({
        query: cQuery,
        data: {
          c: "see",
        },
      });
      await wait();

      checkLastResult(aResults, a456);
      checkLastResult(bResults, bOyez);
      checkLastResult(abResults, a456bOyez);
      checkLastResult(cResults, { c: "see" });

      cache.modify({
        fields: {
          c(value) {
            expect(value).toBe("see");
            return "saw";
          },
        },
      });
      await wait();

      checkLastResult(aResults, a456);
      checkLastResult(bResults, bOyez);
      checkLastResult(abResults, a456bOyez);
      checkLastResult(cResults, { c: "saw" });

      client.cache.evict({ fieldName: "c" });
      await wait();

      checkLastResult(aResults, a456);
      checkLastResult(bResults, bOyez);
      checkLastResult(abResults, a456bOyez);
      expect(checkLastResult(cResults, {}));

      expect(aResults).toEqual([{ a: 123 }, { a: 234 }, { a: 456 }]);

      expect(bResults).toEqual([{ b: "asdf" }, { b: "ASDF" }, { b: "oyez" }]);

      expect(abResults).toEqual([
        { a: 123, b: "asdf" },
        { a: 234, b: "asdf" },
        { a: 234, b: "ASDF" },
        { a: 456, b: "oyez" },
      ]);

      expect(cResults).toEqual([{}, { c: "see" }, { c: "saw" }, {}]);

      subs.forEach((sub) => sub.unsubscribe());

      resolve();
    }
  );

  function wait(time = 10) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  itAsync(
    "should call forgetCache for reactive vars when stopped",
    async (resolve, reject) => {
      const aVar = makeVar(123);
      const bVar = makeVar("asdf");
      const aSpy = jest.spyOn(aVar, "forgetCache");
      const bSpy = jest.spyOn(bVar, "forgetCache");
      const cache: InMemoryCache = new InMemoryCache({
        typePolicies: {
          Query: {
            fields: {
              a() {
                return aVar();
              },
              b() {
                return bVar();
              },
            },
          },
        },
      });

      const client = new ApolloClient({ cache });

      const obsQueries = new Set<ObservableQuery<any>>();
      const subs = new Set<ObservableSubscription>();
      function watch(
        query: DocumentNode,
        fetchPolicy: WatchQueryFetchPolicy = "cache-first"
      ): any[] {
        const results: any[] = [];
        const obsQuery = client.watchQuery({
          query,
          fetchPolicy,
        });
        obsQueries.add(obsQuery);
        subs.add(
          obsQuery.subscribe({
            next(result) {
              results.push(result.data);
            },
          })
        );
        return results;
      }

      const aQuery = gql`
        {
          a
        }
      `;
      const bQuery = gql`
        {
          b
        }
      `;
      const abQuery = gql`
        {
          a
          b
        }
      `;

      const aResults = watch(aQuery);
      const bResults = watch(bQuery);

      expect(cache["watches"].size).toBe(2);

      expect(aResults).toEqual([]);
      expect(bResults).toEqual([]);

      expect(aSpy).not.toBeCalled();
      expect(bSpy).not.toBeCalled();

      subs.forEach((sub) => sub.unsubscribe());

      expect(aSpy).toBeCalledTimes(1);
      expect(aSpy).toBeCalledWith(cache);
      expect(bSpy).toBeCalledTimes(1);
      expect(bSpy).toBeCalledWith(cache);

      expect(aResults).toEqual([]);
      expect(bResults).toEqual([]);

      expect(cache["watches"].size).toBe(0);
      const abResults = watch(abQuery);
      expect(abResults).toEqual([]);
      expect(cache["watches"].size).toBe(1);

      await wait();

      expect(aResults).toEqual([]);
      expect(bResults).toEqual([]);
      expect(abResults).toEqual([{ a: 123, b: "asdf" }]);

      client.stop();

      await wait();

      expect(aSpy).toBeCalledTimes(2);
      expect(aSpy).toBeCalledWith(cache);
      expect(bSpy).toBeCalledTimes(2);
      expect(bSpy).toBeCalledWith(cache);

      resolve();
    }
  );

  describe("default settings", () => {
    const query = gql`
      query number {
        myNumber {
          n
        }
      }
    `;

    const initialData = {
      myNumber: {
        n: 1,
      },
    };
    const networkFetch = {
      myNumber: {
        n: 2,
      },
    };

    itAsync(
      "allows setting default options for watchQuery",
      (resolve, reject) => {
        const link = mockSingleLink({
          request: { query },
          result: { data: networkFetch },
        }).setOnError(reject);
        const client = new ApolloClient({
          link,
          cache: new InMemoryCache({ addTypename: false }),
          defaultOptions: {
            watchQuery: {
              fetchPolicy: "cache-and-network",
            },
          },
        });

        client.writeQuery({
          query,
          data: initialData,
        });

        const obs = client.watchQuery({
          query,
          // This undefined value should be ignored in favor of
          // defaultOptions.watchQuery.fetchPolicy.
          fetchPolicy: void 0,
        });

        subscribeAndCount(reject, obs, (handleCount, result) => {
          const resultData = result.data;
          if (handleCount === 1) {
            expect(resultData).toEqual(initialData);
          } else if (handleCount === 2) {
            expect(resultData).toEqual(networkFetch);
            resolve();
          }
        });
      }
    );

    itAsync(
      "allows setting nextFetchPolicy in defaultOptions",
      (resolve, reject) => {
        let networkCounter = 0;
        let nextFetchPolicyCallCount = 0;

        const client = new ApolloClient({
          link: new ApolloLink(
            (operation) =>
              new Observable((observer) => {
                observer.next({
                  data: {
                    count: networkCounter++,
                  },
                });
                observer.complete();
              })
          ),

          cache: new InMemoryCache(),

          defaultOptions: {
            watchQuery: {
              nextFetchPolicy(fetchPolicy, context) {
                expect(++nextFetchPolicyCallCount).toBe(1);
                expect(this.query).toBe(query);
                expect(fetchPolicy).toBe("cache-first");

                expect(context.reason).toBe("after-fetch");
                expect(context.observable).toBe(obs);
                expect(context.options).toBe(obs.options);
                expect(context.initialFetchPolicy).toBe("cache-first");

                // Usually options.nextFetchPolicy applies only once, but a
                // nextFetchPolicy function can set this.nextFetchPolicy
                // again to perform an additional transition.
                this.nextFetchPolicy = (fetchPolicy) => {
                  ++nextFetchPolicyCallCount;
                  return "cache-first";
                };

                return "cache-and-network";
              },
            },
          },
        });

        const query = gql`
          query {
            count
          }
        `;

        client.writeQuery({
          query,
          data: {
            count: "initial",
          },
        });

        const obs = client.watchQuery({ query });

        subscribeAndCount(reject, obs, (handleCount, result) => {
          if (handleCount === 1) {
            expect(nextFetchPolicyCallCount).toBe(1);
            expect(result.data).toEqual({ count: "initial" });
            // Refetching makes a copy of the current options, which
            // includes options.nextFetchPolicy, so the inner
            // nextFetchPolicy function ends up getting called twice.
            obs.refetch();
          } else if (handleCount === 2) {
            expect(result.data).toEqual({ count: "initial" });
            expect(nextFetchPolicyCallCount).toBe(2);
          } else if (handleCount === 3) {
            expect(result.data).toEqual({ count: 0 });
            expect(nextFetchPolicyCallCount).toBe(2);
            client.writeQuery({
              query,
              data: {
                count: "secondary",
              },
            });
          } else if (handleCount === 4) {
            expect(result.data).toEqual({ count: "secondary" });
            expect(nextFetchPolicyCallCount).toBe(3);
            client.cache.evict({ fieldName: "count" });
          } else if (handleCount === 5) {
            expect(result.data).toEqual({ count: 1 });
            expect(nextFetchPolicyCallCount).toBe(4);
            expect(obs.options.fetchPolicy).toBe("cache-first");
            setTimeout(resolve, 50);
          } else {
            reject("too many results");
          }
        });
      }
    );

    itAsync(
      "can override global defaultOptions.watchQuery.nextFetchPolicy",
      (resolve, reject) => {
        let linkCount = 0;
        const client = new ApolloClient({
          cache: new InMemoryCache(),
          link: new ApolloLink(
            (request) =>
              new Observable((observer) => {
                observer.next({
                  data: {
                    linkCount: ++linkCount,
                  },
                });
                observer.complete();
              })
          ),
          defaultOptions: {
            watchQuery: {
              nextFetchPolicy(currentFetchPolicy) {
                reject(
                  new Error("should not have called global nextFetchPolicy")
                );
                return currentFetchPolicy;
              },
            },
          },
        });

        const query: TypedDocumentNode<{
          linkCount: number;
        }> = gql`
          query CountQuery {
            linkCount
          }
        `;

        let fetchPolicyRecord: WatchQueryFetchPolicy[] = [];
        const observable = client.watchQuery({
          query,
          nextFetchPolicy(currentFetchPolicy) {
            fetchPolicyRecord.push(currentFetchPolicy);
            return "cache-first";
          },
        });

        subscribeAndCount(reject, observable, (resultCount, result) => {
          if (resultCount === 1) {
            expect(result.loading).toBe(false);
            expect(result.data).toEqual({ linkCount: 1 });
            expect(fetchPolicyRecord).toEqual(["cache-first"]);

            return client
              .refetchQueries({
                include: ["CountQuery"],
              })
              .then((results) => {
                expect(results.length).toBe(1);
                results.forEach((result) => {
                  expect(result.loading).toBe(false);
                  expect(result.data).toEqual({ linkCount: 2 });
                });
                expect(fetchPolicyRecord).toEqual([
                  "cache-first",
                  "network-only",
                ]);
              });
          } else if (resultCount === 2) {
            expect(result.loading).toBe(false);
            expect(result.data).toEqual({ linkCount: 2 });
            expect(fetchPolicyRecord).toEqual(["cache-first", "network-only"]);

            return observable
              .reobserve({
                // Allow delivery of loading:true result.
                notifyOnNetworkStatusChange: true,
                // Force a network request in addition to loading:true cache result.
                fetchPolicy: "cache-and-network",
              })
              .then((finalResult) => {
                expect(finalResult.loading).toBe(false);
                expect(finalResult.data).toEqual({ linkCount: 3 });
                expect(fetchPolicyRecord).toEqual([
                  "cache-first",
                  "network-only",
                  "cache-and-network",
                ]);
              });
          } else if (resultCount === 3) {
            expect(result.loading).toBe(true);
            expect(result.data).toEqual({ linkCount: 2 });
          } else if (resultCount === 4) {
            expect(result.loading).toBe(false);
            expect(result.data).toEqual({ linkCount: 3 });
            expect(fetchPolicyRecord).toEqual([
              "cache-first",
              "network-only",
              "cache-and-network",
            ]);

            setTimeout(resolve, 10);
          } else {
            reject(new Error(`Too many results (${resultCount})`));
          }
        });
      }
    );

    itAsync("allows setting default options for query", (resolve, reject) => {
      const errors = [{ message: "failure", name: "failure" }];
      const link = mockSingleLink({
        request: { query },
        result: { errors },
      }).setOnError(reject);
      const client = new ApolloClient({
        link,
        cache: new InMemoryCache({ addTypename: false }),
        defaultOptions: {
          query: { errorPolicy: "all" },
        },
      });

      return client
        .query({ query })
        .then((result) => {
          expect(result.errors).toEqual(errors);
        })
        .then(resolve, reject);
    });

    itAsync(
      "allows setting default options for mutation",
      (resolve, reject) => {
        const mutation = gql`
          mutation upVote($id: ID!) {
            upvote(id: $id) {
              success
            }
          }
        `;

        const data = {
          upvote: { success: true },
        };

        const link = mockSingleLink({
          request: { query: mutation, variables: { id: 1 } },
          result: { data },
        }).setOnError(reject);

        const client = new ApolloClient({
          link,
          cache: new InMemoryCache({ addTypename: false }),
          defaultOptions: {
            mutate: { variables: { id: 1 } },
          },
        });

        return client
          .mutate({
            mutation,
            // This undefined value should be ignored in favor of
            // defaultOptions.mutate.variables.
            variables: void 0,
          })
          .then((result) => {
            expect(result.data).toEqual(data);
          })
          .then(resolve, reject);
      }
    );
  });
});

describe("custom document transforms", () => {
  it("runs custom document transform when calling `query`", async () => {
    const query = gql`
      query TestQuery {
        dogs {
          id
          name
          breed @custom
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          dogs: [
            {
              id: 1,
              name: "Buddy",
              breed: "German Shepard",
              __typename: "Dog",
            },
          ],
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
      documentTransform,
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        dogs {
          id
          name
          breed
          __typename
        }
      }
    `);

    expect(data).toEqual({
      dogs: [
        {
          id: 1,
          name: "Buddy",
          breed: "German Shepard",
          __typename: "Dog",
        },
      ],
    });
  });

  it("requests and caches fields added from custom document transforms when calling `query`", async () => {
    const query = gql`
      query TestQuery {
        dogs {
          name
          breed
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "dogs" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: "id" },
                  },
                  ...node.selectionSet.selections,
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          dogs: [
            {
              id: 1,
              name: "Buddy",
              breed: "German Shepard",
              __typename: "Dog",
            },
          ],
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
      documentTransform,
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        dogs {
          id
          name
          breed
          __typename
        }
      }
    `);

    expect(data).toEqual({
      dogs: [
        {
          id: 1,
          name: "Buddy",
          breed: "German Shepard",
          __typename: "Dog",
        },
      ],
    });

    const cache = client.cache.extract();

    expect(cache["Dog:1"]).toEqual({
      id: 1,
      name: "Buddy",
      breed: "German Shepard",
      __typename: "Dog",
    });
  });

  it("runs document transforms before reading from the cache when calling `query`", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          name
        }
      }
    `;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "product" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  ...node.selectionSet.selections,
                  {
                    kind: Kind.FRAGMENT_SPREAD,
                    name: { kind: Kind.NAME, value: "ProductFields" },
                  },
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink(() => {
      return Observable.of({
        data: {
          product: {
            __typename: "Product",
            id: 2,
            name: "unused",
            description: "unused",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({
        fragments: createFragmentRegistry(gql`
          fragment ProductFields on Product {
            description
          }
        `),
      }),
      documentTransform,
    });

    // Use the transformed document to write to the cache to ensure it contains
    // the fragment spread
    client.writeQuery({
      query: documentTransform.transformDocument(query),
      data: {
        product: {
          __typename: "Product",
          id: 1,
          name: "Cached product",
          description: "Cached product description",
        },
      },
    });

    const { data } = await client.query({ query });

    expect(data).toEqual({
      product: {
        __typename: "Product",
        id: 1,
        name: "Cached product",
        description: "Cached product description",
      },
    });
  });

  it("runs @client directives added from custom transforms through local state", async () => {
    const query = gql`
      query TestQuery {
        currentUser {
          id
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "currentUser" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  ...node.selectionSet.selections,
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: "isLoggedIn" },
                    directives: [
                      {
                        kind: Kind.DIRECTIVE,
                        name: { kind: Kind.NAME, value: "client" },
                      },
                    ],
                  },
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          currentUser: {
            id: 1,
            __typename: "User",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache({
        typePolicies: {
          User: {
            fields: {
              isLoggedIn: {
                read() {
                  return true;
                },
              },
            },
          },
        },
      }),
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        currentUser {
          id
          __typename
        }
      }
    `);

    expect(data).toEqual({
      currentUser: {
        id: 1,
        isLoggedIn: true,
        __typename: "User",
      },
    });
  });

  it("runs custom transform only once when calling `query`", async () => {
    const query = gql`
      query TestQuery {
        currentUser {
          id
        }
      }
    `;

    const transform = jest.fn((document: DocumentNode) => document);
    const documentTransform = new DocumentTransform(transform, {
      cache: false,
    });

    const link = new ApolloLink(() => {
      return Observable.of({
        data: {
          currentUser: {
            id: 1,
            __typename: "User",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    await client.query({ query });

    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("runs default transforms with no custom document transform when calling `query`", async () => {
    const query = gql`
      query TestQuery {
        currentUser @nonreactive {
          id
          isLoggedIn @client
          favoriteFlavors @connection {
            flavor
          }
        }
      }
    `;

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of();
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        currentUser {
          id
          favoriteFlavors {
            flavor
            __typename
          }
          __typename
        }
      }
    `);
  });

  it("runs custom transform when calling `mutate`", async () => {
    const mutation = gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username @custom
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          changeUsername: {
            id: 1,
            username: operation.variables.username,
            __typename: "User",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    const { data } = await client.mutate({
      mutation,
      variables: { username: "foo" },
    });

    expect(document!).toMatchDocument(gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username
          __typename
        }
      }
    `);

    expect(data).toEqual({
      changeUsername: {
        id: 1,
        username: "foo",
        __typename: "User",
      },
    });
  });

  it("runs custom transform on queries defined in refetchQueries using legacy option when calling `mutate`", async () => {
    const mutation = gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username @custom
        }
      }
    `;

    const query = gql`
      query TestQuery {
        currentUser {
          id
          username @custom
        }
      }
    `;

    const requests: Operation[] = [];

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const mocks = [
      {
        request: {
          query: documentTransform.transformDocument(mutation),
          variables: { username: "foo" },
        },
        result: {
          data: {
            changeUsername: { __typename: "User", id: 1, username: "foo" },
          },
        },
      },
      {
        request: { query: documentTransform.transformDocument(query) },
        result: {
          data: {
            currentUser: { __typename: "User", id: 1, username: "foo" },
          },
        },
      },
    ];

    const link = new ApolloLink((operation, forward) => {
      requests.push(operation);

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      documentTransform,
      cache: new InMemoryCache(),
    });

    const { data } = await client.mutate({
      mutation,
      variables: { username: "foo" },
      refetchQueries: [{ query }],
      awaitRefetchQueries: true,
    });

    expect(data).toEqual({
      changeUsername: {
        id: 1,
        username: "foo",
        __typename: "User",
      },
    });

    expect(requests[0].query).toMatchDocument(gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username
          __typename
        }
      }
    `);

    expect(requests[1].query).toMatchDocument(gql`
      query TestQuery {
        currentUser {
          id
          username
          __typename
        }
      }
    `);
  });

  it("requests and caches fields added from custom document transforms when calling `mutate`", async () => {
    const mutation = gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          username
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "changeUsername" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: "id" },
                  },
                  ...node.selectionSet.selections,
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          changeUsername: {
            id: 1,
            username: operation.variables.username,
            __typename: "User",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    const { data } = await client.mutate({
      mutation,
      variables: { username: "foo" },
    });

    expect(document!).toMatchDocument(gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username
          __typename
        }
      }
    `);

    expect(data).toEqual({
      changeUsername: {
        id: 1,
        username: "foo",
        __typename: "User",
      },
    });

    const cache = client.cache.extract();

    expect(cache["User:1"]).toEqual({
      __typename: "User",
      id: 1,
      username: "foo",
    });
  });

  it("runs custom transforms only once when running `mutation`", async () => {
    const mutation = gql`
      mutation TestMutation($username: String) {
        changeUsername(username: $username) {
          id
          username
        }
      }
    `;

    const transform = jest.fn((document: DocumentNode) => document);
    const documentTransform = new DocumentTransform(transform, {
      cache: false,
    });

    const link = new ApolloLink((operation) => {
      return Observable.of({
        data: {
          changeUsername: {
            id: 1,
            username: operation.variables.username,
            __typename: "User",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    await client.mutate({ mutation, variables: { username: "foo" } });

    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("runs default transforms with no custom document transform when calling `mutate`", async () => {
    const mutation = gql`
      mutation TestMutation {
        updateProfile @nonreactive {
          id
          isLoggedIn @client
          favoriteFlavors @connection {
            flavor
          }
        }
      }
    `;

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          updateProfile: {
            __typename: "Profile",
            id: 1,
            favoriteFlavors: [{ __typename: "Flavor", flavor: "Strawberry " }],
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    await client.mutate({ mutation });

    expect(document!).toMatchDocument(gql`
      mutation TestMutation {
        updateProfile {
          id
          favoriteFlavors {
            flavor
            __typename
          }
          __typename
        }
      }
    `);
  });

  it("runs custom document transforms when calling `subscribe`", async () => {
    const query = gql`
      subscription TestSubscription {
        profileUpdated {
          id
          username @custom
        }
      }
    `;

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          profileUpdated: {
            id: 1,
            username: "foo",
            __typename: "Profile",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    const onNext = jest.fn();

    const subscription = client.subscribe({ query }).subscribe(onNext);

    await waitFor(() => subscription.closed);

    expect(document!).toMatchDocument(gql`
      subscription TestSubscription {
        profileUpdated {
          id
          username
          __typename
        }
      }
    `);

    expect(onNext).toHaveBeenLastCalledWith({
      data: {
        profileUpdated: { id: 1, username: "foo", __typename: "Profile" },
      },
    });
  });

  it("requests and caches fields added from custom document transforms when calling `subscribe`", async () => {
    const query = gql`
      subscription TestSubscription {
        profileUpdated {
          username
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "profileUpdated" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  {
                    kind: Kind.FIELD,
                    name: { kind: Kind.NAME, value: "id" },
                  },
                  ...node.selectionSet.selections,
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          profileUpdated: {
            id: 1,
            username: "foo",
            __typename: "Profile",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      documentTransform,
      cache: new InMemoryCache(),
    });

    const onNext = jest.fn();

    const subscription = client.subscribe({ query }).subscribe(onNext);

    await waitFor(() => subscription.closed);

    expect(document!).toMatchDocument(gql`
      subscription TestSubscription {
        profileUpdated {
          id
          username
          __typename
        }
      }
    `);

    expect(onNext).toHaveBeenLastCalledWith({
      data: {
        profileUpdated: { id: 1, username: "foo", __typename: "Profile" },
      },
    });

    const cache = client.cache.extract();

    expect(cache["Profile:1"]).toEqual({
      __typename: "Profile",
      id: 1,
      username: "foo",
    });
  });

  it("runs custom transforms only once when calling `subscribe`", async () => {
    const query = gql`
      subscription TestSubscription {
        profileUpdated {
          username
        }
      }
    `;

    const transform = jest.fn((document: DocumentNode) => document);
    const documentTransform = new DocumentTransform(transform, {
      cache: false,
    });

    const client = new ApolloClient({
      link: ApolloLink.empty(),
      documentTransform,
      cache: new InMemoryCache(),
    });

    const subscription = client.subscribe({ query }).subscribe(jest.fn());

    await waitFor(() => subscription.closed);

    expect(transform).toHaveBeenCalledTimes(1);
  });

  it("runs default transforms with no custom document transform when calling `subscribe`", async () => {
    const query = gql`
      subscription TestSubscription {
        profileUpdated @nonreactive {
          id
          isLoggedIn @client
          favoriteFlavors @connection {
            flavor
          }
        }
      }
    `;

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          profileUpdated: {
            __typename: "Profile",
            id: 1,
            favoriteFlavors: [{ __typename: "Flavor", flavor: "Strawberry " }],
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    const subscription = client.subscribe({ query }).subscribe(jest.fn());

    await waitFor(() => subscription.closed);

    expect(document!).toMatchDocument(gql`
      subscription TestSubscription {
        profileUpdated {
          id
          favoriteFlavors {
            flavor
            __typename
          }
          __typename
        }
      }
    `);
  });

  it("runs custom document transforms when subscribing to observable after calling `watchQuery`", async () => {
    const query = gql`
      query TestQuery {
        currentUser {
          id
          name @custom
        }
      }
    `;

    const transformedQuery = gql`
      query TestQuery {
        currentUser {
          id
          name
          __typename
        }
      }
    `;

    const transform = jest.fn((document: DocumentNode) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const documentTransform = new DocumentTransform(transform, {
      cache: false,
    });

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: { currentUser: { __typename: "User", id: 1, name: "John Doe" } },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
      documentTransform,
    });

    const observable = client.watchQuery({ query });

    expect(transform).toHaveBeenCalledTimes(1);
    // `options.query` should always reflect the raw, untransformed query
    expect(observable.options.query).toMatchDocument(query);
    // The computed `query` property should always reflect the last requested
    // transformed document.
    expect(observable.query).toMatchDocument(transformedQuery);

    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          currentUser: { __typename: "User", id: 1, name: "John Doe" },
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(transformedQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(transformedQuery);
      expect(transform).toHaveBeenCalledTimes(2);
    });
  });

  it("runs default transforms with no custom document transform when calling `watchQuery`", async () => {
    const query = gql`
      query TestQuery @nonreactive {
        currentUser {
          id
          isLoggedIn @client
          favorites @connection {
            id
          }
        }
      }
    `;

    let document: DocumentNode;

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          currentUser: {
            __typename: "User",
            id: 1,
            favorites: [{ __typename: "Favorite", id: 1 }],
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache(),
    });

    const observable = client.watchQuery({ query });

    observable.subscribe(jest.fn());

    await waitFor(() => {
      expect(document!).toMatchDocument(gql`
        query TestQuery {
          currentUser {
            id
            favorites {
              id
              __typename
            }
            __typename
          }
        }
      `);
    });
  });

  it("runs document transforms before reading from the cache when calling `watchQuery`", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          name
        }
      }
    `;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "product" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  ...node.selectionSet.selections,
                  {
                    kind: Kind.FRAGMENT_SPREAD,
                    name: { kind: Kind.NAME, value: "ProductFields" },
                  },
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink(() => {
      return Observable.of({
        data: {
          product: {
            __typename: "Product",
            id: 2,
            name: "unused",
            description: "unused",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({
        fragments: createFragmentRegistry(gql`
          fragment ProductFields on Product {
            description
          }
        `),
      }),
      documentTransform,
    });

    // Use the transformed document to write to the cache to ensure it contains
    // the fragment spread
    client.writeQuery({
      query: documentTransform.transformDocument(query),
      data: {
        product: {
          __typename: "Product",
          id: 1,
          name: "Cached product",
          description: "Cached product description",
        },
      },
    });

    const observable = client.watchQuery({ query });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          product: {
            __typename: "Product",
            id: 1,
            name: "Cached product",
            description: "Cached product description",
          },
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });
    });
  });

  it("re-runs custom document transforms when calling `refetch`", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          metrics @whenEnabled
        }
      }
    `;

    const enabledQuery = gql`
      query TestQuery {
        product {
          id
          metrics
          __typename
        }
      }
    `;

    const disabledQuery = gql`
      query TestQuery {
        product {
          id
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: enabledQuery },
        result: {
          data: {
            product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
          },
        },
      },
      {
        request: { query: disabledQuery },
        result: {
          data: {
            product: { __typename: "Product", id: 1 },
          },
        },
      },
    ];

    let enabled = true;

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument(
          [{ name: "whenEnabled", remove: !enabled }],
          document
        )!;
      },
      { cache: false }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache(),
      documentTransform,
    });

    const observable = client.watchQuery({ query });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(enabledQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(enabledQuery);
    });

    enabled = false;

    const { data } = await observable.refetch();

    expect(document!).toMatchDocument(disabledQuery);
    expect(observable.options.query).toMatchDocument(query);
    expect(observable.query).toMatchDocument(disabledQuery);

    expect(data).toEqual({
      product: { __typename: "Product", id: 1 },
    });

    expect(handleNext).toHaveBeenLastCalledWith({
      data: {
        product: { __typename: "Product", id: 1 },
      },
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("re-runs custom document transforms when calling `fetchMore`", async () => {
    const query = gql`
      query TestQuery($offset: Int) {
        products(offset: $offset) {
          id
          metrics @whenEnabled
        }
      }
    `;

    const enabledQuery = gql`
      query TestQuery($offset: Int) {
        products(offset: $offset) {
          id
          metrics
          __typename
        }
      }
    `;

    const disabledQuery = gql`
      query TestQuery($offset: Int) {
        products(offset: $offset) {
          id
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: enabledQuery, variables: { offset: 0 } },
        result: {
          data: {
            products: [{ __typename: "Product", id: 1, metrics: "1000/vpm" }],
          },
        },
      },
      {
        request: { query: disabledQuery, variables: { offset: 1 } },
        result: {
          data: {
            products: [{ __typename: "Product", id: 2 }],
          },
        },
      },
    ];

    let enabled = true;

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument(
          [{ name: "whenEnabled", remove: !enabled }],
          document
        )!;
      },
      { cache: false }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache({
        typePolicies: {
          Query: {
            fields: {
              products: offsetLimitPagination(),
            },
          },
        },
      }),
      documentTransform,
    });

    const observable = client.watchQuery({ query, variables: { offset: 0 } });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          products: [{ __typename: "Product", id: 1, metrics: "1000/vpm" }],
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(enabledQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(enabledQuery);
    });

    enabled = false;

    const { data } = await observable.fetchMore({ variables: { offset: 1 } });

    expect(document!).toMatchDocument(disabledQuery);
    expect(observable.options.query).toMatchDocument(query);
    expect(observable.query).toMatchDocument(disabledQuery);

    expect(data).toEqual({
      products: [{ __typename: "Product", id: 2 }],
    });

    expect(handleNext).toHaveBeenLastCalledWith({
      data: {
        products: [
          { __typename: "Product", id: 1 },
          { __typename: "Product", id: 2 },
        ],
      },
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("runs custom document transforms on the passed query and original query when calling `fetchMore` with a different query", async () => {
    const initialQuery = gql`
      query TestQuery($offset: Int) {
        currentUser {
          id
        }
        products(offset: $offset) {
          id
          metrics @whenEnabled
        }
      }
    `;

    const enabledInitialQuery = gql`
      query TestQuery($offset: Int) {
        currentUser {
          id
          __typename
        }
        products(offset: $offset) {
          id
          metrics
          __typename
        }
      }
    `;

    const disabledInitialQuery = gql`
      query TestQuery($offset: Int) {
        currentUser {
          id
          __typename
        }
        products(offset: $offset) {
          id
          __typename
        }
      }
    `;

    const productsQuery = gql`
      query TestQuery($offset: Int) {
        products(offset: $offset) {
          id
          metrics @whenEnabled
        }
      }
    `;

    const transformedProductsQuery = gql`
      query TestQuery($offset: Int) {
        products(offset: $offset) {
          id
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: enabledInitialQuery, variables: { offset: 0 } },
        result: {
          data: {
            currentUser: { id: 1 },
            products: [{ __typename: "Product", id: 1, metrics: "1000/vpm" }],
          },
        },
      },
      {
        request: { query: transformedProductsQuery, variables: { offset: 1 } },
        result: {
          data: {
            products: [{ __typename: "Product", id: 2 }],
          },
        },
      },
    ];

    let enabled = true;

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument(
          [{ name: "whenEnabled", remove: !enabled }],
          document
        )!;
      },
      { cache: false }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache({
        typePolicies: {
          Query: {
            fields: {
              products: {
                keyArgs: false,
                merge(existing = [], incoming) {
                  return [...existing, ...incoming];
                },
              },
            },
          },
        },
      }),
      documentTransform,
    });

    const observable = client.watchQuery({
      query: initialQuery,
      variables: { offset: 0 },
    });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          currentUser: { id: 1 },
          products: [{ __typename: "Product", id: 1, metrics: "1000/vpm" }],
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(handleNext).toHaveBeenCalledTimes(1);
      expect(document).toMatchDocument(enabledInitialQuery);
      expect(observable.options.query).toMatchDocument(initialQuery);
      expect(observable.query).toMatchDocument(enabledInitialQuery);
    });

    enabled = false;

    const { data } = await observable.fetchMore({
      query: productsQuery,
      variables: { offset: 1 },
    });

    expect(data).toEqual({
      products: [{ __typename: "Product", id: 2 }],
    });

    expect(document!).toMatchDocument(transformedProductsQuery);
    expect(observable.options.query).toMatchDocument(initialQuery);
    // Even though we pass a different query to `fetchMore`, we don't want to
    // override the original query. We do however run transforms on the
    // initial query to ensure the broadcasted result and the cache match
    // the expected query document in case the transforms contain a runtime
    // condition that impacts the query in a significant way (such as removing
    // a field).
    expect(observable.query).toMatchDocument(disabledInitialQuery);

    // QueryInfo.notify is run in a setTimeout, so give time for it to run
    // before we make assertions on it.
    await wait(0);

    expect(handleNext).toHaveBeenCalledTimes(2);
    expect(handleNext).toHaveBeenLastCalledWith({
      data: {
        currentUser: { id: 1 },
        products: [
          { __typename: "Product", id: 1 },
          { __typename: "Product", id: 2 },
        ],
      },
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("re-runs custom document transforms when calling `setVariables`", async () => {
    const query = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics @whenEnabled
        }
      }
    `;

    const enabledQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics
          __typename
        }
      }
    `;

    const disabledQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: enabledQuery, variables: { id: 1 } },
        result: {
          data: {
            product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
          },
        },
      },
      {
        request: { query: disabledQuery, variables: { id: 2 } },
        result: {
          data: {
            product: { __typename: "Product", id: 2 },
          },
        },
      },
    ];

    let enabled = true;

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument(
          [{ name: "whenEnabled", remove: !enabled }],
          document
        )!;
      },
      { cache: false }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache(),
      documentTransform,
    });

    const observable = client.watchQuery({ query, variables: { id: 1 } });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(enabledQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(enabledQuery);
    });

    enabled = false;

    const result = await observable.setVariables({ id: 2 });

    expect(document!).toMatchDocument(disabledQuery);
    expect(observable.options.query).toMatchDocument(query);
    expect(observable.query).toMatchDocument(disabledQuery);

    expect(result!.data).toEqual({
      product: { __typename: "Product", id: 2 },
    });

    expect(handleNext).toHaveBeenLastCalledWith({
      data: {
        product: { __typename: "Product", id: 2 },
      },
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("re-runs custom document transforms when calling `setOptions`", async () => {
    const query = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics @whenEnabled
        }
      }
    `;

    const enabledQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics
          __typename
        }
      }
    `;

    const disabledQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: enabledQuery, variables: { id: 1 } },
        result: {
          data: {
            product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
          },
        },
      },
      {
        request: { query: disabledQuery, variables: { id: 2 } },
        result: {
          data: {
            product: { __typename: "Product", id: 2 },
          },
        },
      },
    ];

    let enabled = true;

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument(
          [{ name: "whenEnabled", remove: !enabled }],
          document
        )!;
      },
      { cache: false }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache(),
      documentTransform,
    });

    const observable = client.watchQuery({ query, variables: { id: 1 } });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: {
          product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
        },
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(enabledQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(enabledQuery);
    });

    enabled = false;

    const { data } = await observable.setOptions({ variables: { id: 2 } });

    expect(document!).toMatchDocument(disabledQuery);
    expect(observable.options.query).toMatchDocument(query);
    expect(observable.query).toMatchDocument(disabledQuery);

    expect(data).toEqual({
      product: { __typename: "Product", id: 2 },
    });

    expect(handleNext).toHaveBeenLastCalledWith({
      data: {
        product: { __typename: "Product", id: 2 },
      },
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("runs custom document transforms when passing a new query to `setOptions`", async () => {
    const query = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics @custom
        }
      }
    `;

    const transformedQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          metrics
          __typename
        }
      }
    `;

    const updatedQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          name
          metrics @custom
        }
      }
    `;

    const transformedUpdatedQuery = gql`
      query TestQuery($id: ID!) {
        product(id: $id) {
          id
          name
          metrics
          __typename
        }
      }
    `;

    const mocks = [
      {
        request: { query: transformedQuery, variables: { id: 1 } },
        result: {
          data: {
            product: { __typename: "Product", id: 1, metrics: "1000/vpm" },
          },
        },
      },
      {
        request: { query: transformedUpdatedQuery, variables: { id: 1 } },
        result: {
          data: {
            product: {
              __typename: "Product",
              id: 1,
              name: "Acme Inc Product",
              metrics: "1000/vpm",
            },
          },
        },
      },
    ];

    const documentTransform = new DocumentTransform(
      (document: DocumentNode) => {
        return removeDirectivesFromDocument([{ name: "custom" }], document)!;
      }
    );

    let document: DocumentNode;

    const link = new ApolloLink((operation, forward) => {
      document = operation.query;

      return forward(operation);
    });

    const client = new ApolloClient({
      link: ApolloLink.from([link, new MockLink(mocks)]),
      cache: new InMemoryCache(),
      documentTransform,
    });

    const observable = client.watchQuery({ query, variables: { id: 1 } });
    const handleNext = jest.fn();

    observable.subscribe(handleNext);

    await waitFor(() => {
      expect(handleNext).toHaveBeenLastCalledWith({
        data: mocks[0].result.data,
        loading: false,
        networkStatus: NetworkStatus.ready,
      });

      expect(document).toMatchDocument(transformedQuery);
      expect(observable.options.query).toMatchDocument(query);
      expect(observable.query).toMatchDocument(transformedQuery);
    });

    const { data } = await observable.setOptions({ query: updatedQuery });

    expect(document!).toMatchDocument(transformedUpdatedQuery);
    expect(observable.options.query).toMatchDocument(updatedQuery);
    expect(observable.query).toMatchDocument(transformedUpdatedQuery);

    expect(data).toEqual(mocks[1].result.data);

    expect(handleNext).toHaveBeenLastCalledWith({
      data: mocks[1].result.data,
      loading: false,
      networkStatus: NetworkStatus.ready,
    });
  });

  it("runs custom document transforms with fragments defined in the fragment registery", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          name @custom
          ...ProductFields
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          product: {
            __typename: "Product",
            id: 1,
            name: "Product",
            description: "Product description",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({
        fragments: createFragmentRegistry(gql`
          fragment ProductFields on Product {
            description @custom
          }
        `),
      }),
      documentTransform,
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        product {
          id
          name
          ...ProductFields
          __typename
        }
      }

      fragment ProductFields on Product {
        description
        __typename
      }
    `);

    expect(data).toEqual({
      product: {
        __typename: "Product",
        id: 1,
        name: "Product",
        description: "Product description",
      },
    });
  });

  it("runs custom document transforms on fragments that override registered fragments in the fragment registery", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          name @custom
          ...ProductFields
        }
      }

      fragment ProductFields on Product {
        description @custom
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          product: {
            __typename: "Product",
            id: 1,
            name: "Product",
            description: "Product description",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({
        fragments: createFragmentRegistry(gql`
          fragment ProductFields on Product {
            unused @custom
          }
        `),
      }),
      documentTransform,
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        product {
          id
          name
          ...ProductFields
          __typename
        }
      }

      fragment ProductFields on Product {
        description
        __typename
      }
    `);

    expect(data).toEqual({
      product: {
        __typename: "Product",
        id: 1,
        name: "Product",
        description: "Product description",
      },
    });
  });

  it("adds fragment definitions to the query for fragment spreads added from custom document transforms", async () => {
    const query = gql`
      query TestQuery {
        product {
          id
          name
        }
      }
    `;

    let document: DocumentNode;

    const documentTransform = new DocumentTransform((document) => {
      return visit(document, {
        Field(node) {
          if (node.name.value === "product" && node.selectionSet) {
            return {
              ...node,
              selectionSet: {
                ...node.selectionSet,
                selections: [
                  ...node.selectionSet.selections,
                  {
                    kind: Kind.FRAGMENT_SPREAD,
                    name: { kind: Kind.NAME, value: "ProductFields" },
                  },
                ],
              },
            };
          }
        },
      });
    });

    const link = new ApolloLink((operation) => {
      document = operation.query;

      return Observable.of({
        data: {
          product: {
            __typename: "Product",
            id: 1,
            name: "Product",
            description: "Product description",
          },
        },
      });
    });

    const client = new ApolloClient({
      link,
      cache: new InMemoryCache({
        fragments: createFragmentRegistry(gql`
          fragment ProductFields on Product {
            description
          }
        `),
      }),
      documentTransform,
    });

    const { data } = await client.query({ query });

    expect(document!).toMatchDocument(gql`
      query TestQuery {
        product {
          id
          name
          __typename
          ...ProductFields
        }
      }

      fragment ProductFields on Product {
        description
        __typename
      }
    `);

    expect(data).toEqual({
      product: {
        __typename: "Product",
        id: 1,
        name: "Product",
        description: "Product description",
      },
    });
  });

  it('runs custom transforms on active queries when calling `refetchQueries` with "include"', async () => {
    const aQuery = gql`
      query A {
        a @custom
      }
    `;
    const bQuery = gql`
      query B {
        b @custom
      }
    `;
    const abQuery = gql`
      query AB {
        a @custom
        b
      }
    `;

    const requests: Operation[] = [];

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const client = new ApolloClient({
      documentTransform,
      cache: new InMemoryCache(),
      link: new ApolloLink((operation) => {
        requests.push(operation);

        return Observable.of({
          data: operation.operationName
            .split("")
            .reduce<Record<string, string>>(
              (memo, letter) => ({
                ...memo,
                [letter.toLowerCase()]: letter.toUpperCase(),
              }),
              {}
            ),
        });
      }),
    });

    client.watchQuery({ query: aQuery }).subscribe(jest.fn());
    client.watchQuery({ query: bQuery }).subscribe(jest.fn());
    // purposely avoid subscribing to prevent it from being an "active" query
    client.watchQuery({ query: abQuery });

    await waitFor(() => {
      return (
        client.readQuery({ query: aQuery }) &&
        client.readQuery({ query: bQuery })
      );
    });

    expect(requests.length).toBe(2);
    expect(requests[0].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[1].query).toMatchDocument(gql`
      query B {
        b
      }
    `);

    const results = await client.refetchQueries({ include: "active" });

    expect(results.map((r) => r.data)).toEqual([{ a: "A" }, { b: "B" }]);

    expect(requests.length).toBe(4);
    expect(requests[2].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[3].query).toMatchDocument(gql`
      query B {
        b
      }
    `);
  });

  it('runs custom transforms on all queries when calling `refetchQueries` with "all"', async () => {
    const aQuery = gql`
      query A {
        a @custom
      }
    `;
    const bQuery = gql`
      query B {
        b @custom
      }
    `;
    const abQuery = gql`
      query AB {
        a @custom
        b
      }
    `;

    const requests: Operation[] = [];

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const client = new ApolloClient({
      documentTransform,
      cache: new InMemoryCache(),
      link: new ApolloLink((operation) => {
        requests.push(operation);

        return Observable.of({
          data: operation.operationName
            .split("")
            .reduce<Record<string, string>>(
              (memo, letter) => ({
                ...memo,
                [letter.toLowerCase()]: letter.toUpperCase(),
              }),
              {}
            ),
        });
      }),
    });

    client.watchQuery({ query: aQuery }).subscribe(jest.fn());
    client.watchQuery({ query: bQuery }).subscribe(jest.fn());
    // purposely avoid subscribing to prevent it from being an "active" query
    client.watchQuery({ query: abQuery });

    await waitFor(() => {
      return (
        client.readQuery({ query: aQuery }) &&
        client.readQuery({ query: bQuery })
      );
    });

    expect(requests.length).toBe(2);
    expect(requests[0].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[1].query).toMatchDocument(gql`
      query B {
        b
      }
    `);

    const results = await client.refetchQueries({ include: "all" });

    expect(results.map((r) => r.data)).toEqual([
      { a: "A" },
      { b: "B" },
      { a: "A", b: "B" },
    ]);

    expect(requests.length).toBe(5);
    expect(requests[2].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[3].query).toMatchDocument(gql`
      query B {
        b
      }
    `);
    expect(requests[4].query).toMatchDocument(gql`
      query AB {
        a
        b
      }
    `);
  });

  it("runs custom transforms on matched queries when calling `refetchQueries` with string array", async () => {
    const aQuery = gql`
      query A {
        a @custom
      }
    `;
    const bQuery = gql`
      query B {
        b @custom
      }
    `;

    const requests: Operation[] = [];

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const client = new ApolloClient({
      documentTransform,
      cache: new InMemoryCache(),
      link: new ApolloLink((operation) => {
        requests.push(operation);

        return Observable.of({
          data: operation.operationName
            .split("")
            .reduce<Record<string, string>>(
              (memo, letter) => ({
                ...memo,
                [letter.toLowerCase()]: letter.toUpperCase(),
              }),
              {}
            ),
        });
      }),
    });

    client.watchQuery({ query: aQuery }).subscribe(jest.fn());
    client.watchQuery({ query: bQuery }).subscribe(jest.fn());

    await waitFor(() => {
      return (
        client.readQuery({ query: aQuery }) &&
        client.readQuery({ query: bQuery })
      );
    });

    expect(requests.length).toBe(2);
    expect(requests[0].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[1].query).toMatchDocument(gql`
      query B {
        b
      }
    `);

    const results = await client.refetchQueries({
      include: ["B"],
    });

    expect(results.map((r) => r.data)).toEqual([{ b: "B" }]);

    expect(requests.length).toBe(3);
    expect(requests[2].query).toMatchDocument(gql`
      query B {
        b
      }
    `);
  });

  it("runs custom transforms on matched queries when calling `refetchQueries` with document nodes", async () => {
    const aQuery = gql`
      query A {
        a @custom
      }
    `;
    const bQuery = gql`
      query B {
        b @custom
      }
    `;

    const requests: Operation[] = [];

    const documentTransform = new DocumentTransform((document) => {
      return removeDirectivesFromDocument([{ name: "custom" }], document)!;
    });

    const client = new ApolloClient({
      documentTransform,
      cache: new InMemoryCache(),
      link: new ApolloLink((operation) => {
        requests.push(operation);

        return Observable.of({
          data: operation.operationName
            .split("")
            .reduce<Record<string, string>>(
              (memo, letter) => ({
                ...memo,
                [letter.toLowerCase()]: letter.toUpperCase(),
              }),
              {}
            ),
        });
      }),
    });

    client.watchQuery({ query: aQuery }).subscribe(jest.fn());
    client.watchQuery({ query: bQuery }).subscribe(jest.fn());

    await waitFor(() => {
      return (
        client.readQuery({ query: aQuery }) &&
        client.readQuery({ query: bQuery })
      );
    });

    expect(requests.length).toBe(2);
    expect(requests[0].query).toMatchDocument(gql`
      query A {
        a
      }
    `);
    expect(requests[1].query).toMatchDocument(gql`
      query B {
        b
      }
    `);

    const results = await client.refetchQueries({
      include: [bQuery],
    });

    expect(results.map((r) => r.data)).toEqual([{ b: "B" }]);

    expect(requests.length).toBe(3);
    expect(requests[2].query).toMatchDocument(gql`
      query B {
        b
      }
    `);
  });
});

function clientRoundtrip(
  resolve: (result: any) => any,
  reject: (reason: any) => any,
  query: DocumentNode,
  data: ExecutionResult,
  variables?: any,
  possibleTypes?: PossibleTypesMap
) {
  const link = mockSingleLink({
    request: { query: cloneDeep(query) },
    result: data,
  }).setOnError(reject);

  const client = new ApolloClient({
    link,
    cache: new InMemoryCache({
      possibleTypes,
    }),
  });

  return client
    .query({ query, variables })
    .then((result) => {
      expect(result.data).toEqual(data.data);
    })
    .then(resolve, reject);
}
