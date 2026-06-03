# Demo

clone the repo

`aspire start`

## Part 1 - Talk through dashboard and app

Open dashboard - "so, a lot of things just happened with that one CLI command"

Aspire kicked off quite a few processes - 3 npm installs, for my api, planner service, and frontend, and then 3 separate npm runs for each.

It also pulled down docker container images and spun up docker containers for Postgres DB and the postgres admin UI. Before we dive into lets look at this app.

(CLick around frontend explain the basics of the app)

Now, if i go back to the dashboard, I can see what just happened behind the scenes.

I can see the console logs for all the different pieces of my app - the services, the frontend, the db.

Plus, my app emits open telemetry - OTEL - so I can see all the traces between the different pieces of my app in this aspire dashboard.

For each resource, I can see the config aspire injected and wired up, so even though my ports are randomized - which is great for copilot in worktrees by the way - the frontend still knows where the backend is.

I also built in a ton of custom commands so that I can do common testing flows right here in the dashboard - like seed some data in the db.

The nice thing about this is its running in the context of my whole stack, all locally. It's not mocking things. It knows where all of the services are running and what env they need to function.

So how does this work???

(Flip over to VS Code)

## Part 2 - explain teh apphost

In Aspire, everything is defined in code, in what we call the apphost. 

Like we showed in the slides, the apphost is a strongly-typed model of your app. In this app we have a handful of resources that drive that experience we just showed.

And we use these things called integrations to package up sane defaults for how we think you wat to build and launch these things. Then we give you a ton of different extension methods and parameters and patterns to customize it however you need to build out your dev ex.

(Go resource by resource in the apphost explaining what each is doing - ignore deployment first)

This is typescript but you can model it the same way in C#, and we have preview support for modeling this in Python, Java, Go, and more.

What's important though is that it doesn't matter what language this apphost is in - you can still run any type of app from it. Or container.

The way we handle custom coommands, in this case, is over HTTP - I have some endpoints in my api I want to be able to hit at will, and I defined those in the app host down here.

So one CLI command starts up everything, wires them together, and manages their individual states.

Now, everything you saw in the dashboard is great for me - a human - to look at and interact with. But most of my dev now starts with a coding agent, not an editor.

## Part 3 - CLI + agent-first interactions

Which is why the aspire cli is able to expose everything I see in the dashboard in really agent freindly ways. We also have a curated set of skills - you can get them easily by running `aspire agent init` - that will pull in things to help the agent wield the Aspire CLI in a meaningful and efficient way.

So I'll go ask the agent - hey, can you restart the database container, clear the volume mount and then reseeed it? Let me know when everything is healthy.

And it's able to do all that via aspire's cli, same as I'm able to do it - and observe it - in the dashboard.

## Part 4 - Riff on other local dev things?

## Part 5 - Explaining deployment

SO, I want to deploy this now. But I'm not going to go write a bunch of bicep. I have an app model right here that knows how everything connects, aspire is able to translate this into bicep,using integrations we build specifically for deployment.

We have deployment integrations for a bunch of Azure compute platforms, AWS, and generic k8s and docker compose. I'm going to use container apps for this.

(`aspire add containers`)

This added an integration for container apps - each of the resources in teh apphost know how to turn themselves into deployable containerized assets, and i can override whatever, but they know how to basically become their own dockerfile.

The Azure container app integration knows how to take all of these primitive deployable assets and the app model that represents how they relate, then stitch them together using bicep.

We have integrations for ACA and App Service, vanilla kubernetes and AKS, and docker compose and AWS. But you dnt have to use aspire for deployment if you dont want to. But it is super powerful - you dont have to hand author deployment artifacts anymore.

With Aspire, you can use code to define any property you'd need to define in bicep too. Or, overwrite the dockerfile output to add custom steps. We expose things as strongly typed objects so i can write actual code to create bicep properties or helm chart values.